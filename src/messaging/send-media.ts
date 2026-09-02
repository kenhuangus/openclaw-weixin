import path from "node:path";

import type { WeixinApiOptions } from "../api/api.js";
import { logger } from "../util/logger.js";
import { getMimeFromFilename } from "../media/mime.js";
import { isWeixinAudioFilename, prepareOutboundVoice } from "../media/silk-transcode.js";
import {
  sendFileMessageWeixin,
  sendImageMessageWeixin,
  sendVideoMessageWeixin,
  sendVoiceMessageWeixin,
} from "./send.js";
import {
  uploadFileAttachmentToWeixin,
  uploadFileToWeixin,
  uploadVideoToWeixin,
  uploadVoiceToWeixin,
} from "../cdn/upload.js";

export type SendWeixinMediaFileParams = {
  filePath: string;
  to: string;
  text: string;
  opts: WeixinApiOptions & { contextToken?: string; runId?: string };
  cdnBaseUrl: string;
  /** Force native VOICE item (语音条). Default: true for audio files. */
  asVoice?: boolean;
  /** Force FILE attachment even for audio (legacy / fallback). */
  forceDocument?: boolean;
};

function shouldSendNativeVoice(filePath: string, mime: string, params: SendWeixinMediaFileParams): boolean {
  if (params.forceDocument) return false;
  if (params.asVoice === false) return false;
  if (params.asVoice === true) return true;
  return mime.startsWith("audio/") || isWeixinAudioFilename(filePath);
}

async function sendAsFileAttachment(params: SendWeixinMediaFileParams): Promise<{ messageId: string }> {
  const { filePath, to, text, opts, cdnBaseUrl } = params;
  const uploadOpts: WeixinApiOptions = { baseUrl: opts.baseUrl, token: opts.token };
  const fileName = path.basename(filePath);
  logger.info(
    `[weixin] sendWeixinMediaFile: uploading file attachment filePath=${filePath} name=${fileName} to=${to}`,
  );
  const uploaded = await uploadFileAttachmentToWeixin({
    filePath,
    fileName,
    toUserId: to,
    opts: uploadOpts,
    cdnBaseUrl,
  });
  logger.info(
    `[weixin] sendWeixinMediaFile: file upload done filekey=${uploaded.filekey} size=${uploaded.fileSize}`,
  );
  return sendFileMessageWeixin({ to, text, fileName, uploaded, opts });
}

async function sendAsNativeVoice(params: SendWeixinMediaFileParams): Promise<{ messageId: string }> {
  const { filePath, to, text, opts, cdnBaseUrl } = params;
  const uploadOpts: WeixinApiOptions = { baseUrl: opts.baseUrl, token: opts.token };
  const voice = await prepareOutboundVoice(filePath);
  try {
    logger.info(
      `[weixin] sendWeixinMediaFile: uploading VOICE filePath=${voice.filePath} playtimeMs=${voice.playtimeMs} to=${to}`,
    );
    const uploaded = await uploadVoiceToWeixin({
      filePath: voice.filePath,
      toUserId: to,
      opts: uploadOpts,
      cdnBaseUrl,
    });
    logger.info(
      `[weixin] sendWeixinMediaFile: voice upload done filekey=${uploaded.filekey} size=${uploaded.fileSize}`,
    );
    return await sendVoiceMessageWeixin({
      to,
      text,
      uploaded,
      opts,
      playtimeMs: voice.playtimeMs,
      encodeType: voice.encodeType,
      sampleRate: voice.sampleRate,
      bitsPerSample: voice.bitsPerSample,
    });
  } finally {
    await voice.cleanup();
  }
}

/**
 * Upload a local file and send it as a weixin message, routing by MIME type:
 *   video/*  → uploadVideoToWeixin        + sendVideoMessageWeixin
 *   image/*  → uploadFileToWeixin         + sendImageMessageWeixin
 *   audio/*  → uploadVoiceToWeixin        + sendVoiceMessageWeixin  (native 语音条)
 *   else     → uploadFileAttachmentToWeixin + sendFileMessageWeixin
 *
 * Native voice falls back to a FILE attachment if SILK encode / VOICE upload / send fails,
 * so TTS still delivers something the client can play.
 *
 * Used by both the auto-reply deliver path (monitor.ts) and the outbound
 * sendMedia path (channel.ts) so they stay in sync.
 */
export async function sendWeixinMediaFile(
  params: SendWeixinMediaFileParams,
): Promise<{ messageId: string }> {
  const { filePath, to, text, opts, cdnBaseUrl } = params;
  const mime = getMimeFromFilename(filePath);
  const uploadOpts: WeixinApiOptions = { baseUrl: opts.baseUrl, token: opts.token };

  if (shouldSendNativeVoice(filePath, mime, params)) {
    try {
      return await sendAsNativeVoice(params);
    } catch (err) {
      logger.warn(
        `[weixin] sendWeixinMediaFile: native VOICE failed, falling back to FILE attachment err=${String(err)}`,
      );
      return sendAsFileAttachment(params);
    }
  }

  if (mime.startsWith("video/")) {
    logger.info(`[weixin] sendWeixinMediaFile: uploading video filePath=${filePath} to=${to}`);
    const uploaded = await uploadVideoToWeixin({
      filePath,
      toUserId: to,
      opts: uploadOpts,
      cdnBaseUrl,
    });
    logger.info(
      `[weixin] sendWeixinMediaFile: video upload done filekey=${uploaded.filekey} size=${uploaded.fileSize}`,
    );
    return sendVideoMessageWeixin({ to, text, uploaded, opts });
  }

  if (mime.startsWith("image/")) {
    logger.info(`[weixin] sendWeixinMediaFile: uploading image filePath=${filePath} to=${to}`);
    const uploaded = await uploadFileToWeixin({
      filePath,
      toUserId: to,
      opts: uploadOpts,
      cdnBaseUrl,
    });
    logger.info(
      `[weixin] sendWeixinMediaFile: image upload done filekey=${uploaded.filekey} size=${uploaded.fileSize}`,
    );
    return sendImageMessageWeixin({ to, text, uploaded, opts });
  }

  return sendAsFileAttachment(params);
}
