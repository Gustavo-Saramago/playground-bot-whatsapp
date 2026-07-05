'use strict';

const { Blob } = require('node:buffer');

async function transcribeAudioMedia(media, options = {}) {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    console.warn('[Transcriber] OPENAI_API_KEY não configurada. Não foi possível transcrever o áudio e o bot vai responder no fallback humano.');
    return { text: '', reason: 'missing_api_key' };
  }

  const data = String(media?.data || '').trim();
  if (!data) {
    return { text: '', reason: 'empty_media_data' };
  }

  const buffer = Buffer.from(data, 'base64');
  if (buffer.length === 0) {
    return { text: '', reason: 'empty_audio_buffer' };
  }

  const fileName = options.fileName || media?.filename || 'audio.ogg';
  const mimeType = String(media?.mimetype || options.mimeType || 'audio/ogg').trim();
  const blob = new Blob([buffer], { type: mimeType });

  const formData = new FormData();
  formData.append('model', 'whisper-1');
  formData.append('file', blob, fileName);
  formData.append('response_format', 'json');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Falha na transcricao de audio (${response.status}): ${errorText || response.statusText}`);
  }

  const payload = await response.json();
  const text = String(payload?.text || '').trim();
  return {
    text,
    reason: text ? 'ok' : 'empty_transcript',
  };
}

module.exports = {
  transcribeAudioMedia,
};