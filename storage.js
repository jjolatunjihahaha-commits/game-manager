import { getFileAttachment, uploadFileAttachment, deleteFileFromServer } from '../../../chats.js';
import { getStringHash, convertTextToBase64 } from '../../../utils.js';

const PREFIX = '[Game Manager]';

export function safeFilePart(value) {
    return String(value || 'Character').trim().replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'Character';
}

export function getCharacterAttachments(avatar, extensionSettings) {
    extensionSettings.character_attachments ??= {};
    extensionSettings.character_attachments[avatar] ??= [];
    return extensionSettings.character_attachments[avatar];
}

export async function readCharacterFile(avatar, fileName, extensionSettings) {
    const attachment = getCharacterAttachments(avatar, extensionSettings).find(item => item.name === fileName);
    if (!attachment) return '';
    return (await getFileAttachment(attachment.url)) || '';
}

export async function writeCharacterFile(avatar, fileName, content, context) {
    const attachments = getCharacterAttachments(avatar, context.extensionSettings);
    const encoded = convertTextToBase64(String(content ?? ''));
    const uploadName = `${Date.now()}_${getStringHash(fileName)}.txt`;
    const url = await uploadFileAttachment(uploadName, encoded);
    if (!url) throw new Error(`SillyTavern could not upload ${fileName}. The previous file was preserved.`);

    const old = attachments.find(item => item.name === fileName);
    if (old) {
        try {
            await deleteFileFromServer(old.url, true);
        } catch (error) {
            console.warn(PREFIX, `Old attachment cleanup failed for ${fileName}; new file was uploaded.`, error);
        }
        context.extensionSettings.character_attachments[avatar] = attachments.filter(item => item.url !== old.url);
    }
    context.extensionSettings.character_attachments[avatar].push({
        url,
        size: String(content ?? '').length,
        name: fileName,
        created: Date.now(),
    });
    context.saveSettingsDebounced();
}

export async function readCharMemoryFiles(avatar, extensionSettings) {
    const attachments = getCharacterAttachments(avatar, extensionSettings);
    const candidates = attachments.filter(item => /memories\.md$/i.test(item.name || ''));
    const results = [];
    for (const attachment of candidates) {
        try {
            const content = (await getFileAttachment(attachment.url)) || '';
            if (content.trim()) results.push({ name: attachment.name, content });
        } catch (error) {
            console.warn(PREFIX, `Could not read CharMemory file ${attachment.name}.`, error);
        }
    }
    return results;
}
