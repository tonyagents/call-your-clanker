import { createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const AUDIO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'audio');

/**
 * Synthesize speech with ElevenLabs and cache the mp3 under public/audio.
 * Returns a path like "/audio/<hash>.mp3", or null if no API key / failure
 * (caller falls back to Twilio <Say>).
 */
export async function synthesize(text) {
  const { apiKey, voiceId, modelId } = config.elevenlabs;
  if (!apiKey) return null;

  const hash = createHash('sha1').update(`${voiceId}:${modelId}:${text}`).digest('hex');
  const filename = `${hash}.mp3`;
  const filePath = path.join(AUDIO_DIR, filename);
  if (existsSync(filePath)) return `/audio/${filename}`;

  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_22050_32`,
      {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: modelId,
          voice_settings: { stability: 0.45, similarity_boost: 0.8 },
        }),
      },
    );
    if (!res.ok) {
      console.error(`[tts] ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    await mkdir(AUDIO_DIR, { recursive: true });
    await writeFile(filePath, Buffer.from(await res.arrayBuffer()));
    return `/audio/${filename}`;
  } catch (err) {
    console.error('[tts] synthesis failed:', err.message);
    return null;
  }
}

/**
 * Add the spoken text to a TwiML response (or a <Gather> inside one):
 * ElevenLabs <Play> when available, Twilio <Say> otherwise.
 */
export async function speak(node, text) {
  const audioPath = await synthesize(text);
  if (audioPath && config.publicUrl) node.play(`${config.publicUrl}${audioPath}`);
  else node.say({ voice: 'Polly.Matthew-Neural' }, text);
}
