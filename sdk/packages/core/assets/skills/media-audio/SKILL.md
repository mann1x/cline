---
name: media-audio
description: >-
  Reads and makes audio: turns a recording into text or subtitles, and turns
  text into spoken audio. Use when the user asks to transcribe a recording, a
  meeting, a voice note or the sound of a video, to make subtitles, to
  translate speech, or to make a voice-over, a spoken prompt or an audio
  version of a text.
---

# Audio

You can read audio and make speech yourself. Do not ask the user to describe a
recording you could transcribe, or to record something you could synthesize.

## Which tool

| The task | Use |
|---|---|
| What is said in an audio file | `transcribe_audio` |
| Subtitles for a recording or a clip | `transcribe_audio` with `format: srt` or `vtt` |
| The English of speech in another language | `transcribe_audio` with `translate: true` |
| A voice-over, a spoken prompt, an audio version of a text | `synthesize_speech` |

When you do not have the tool you need, it is not set up. Say that the user
turns it on in **Settings > API Configuration > Audio** (the speech-to-text
endpoint for transcription, the text-to-speech endpoint for speech), and stop
there.

## Transcribing

- The file has to be in the workspace: wav, mp3, flac, ogg, m4a or webm. For
  the sound of a video in another container, extract the audio first with the
  project's tools (`ffmpeg -i clip.mp4 -vn audio.m4a`) if they are installed.
- Give `output` a path for anything longer than a few minutes, and for
  subtitles: the whole transcript is saved there and you get its beginning.
  Read the file for the rest.
- Give `prompt` the names and terms the recording uses. It fixes spelling.
- Give `language` when you know it; detection can pick the wrong one on a
  short or noisy recording.
- A transcript is what was heard, not what was meant. When it is the basis of
  a summary, minutes or tasks, say where a passage was unclear.

## Speaking

- Write the text as it should be said: spell out abbreviations, write numbers
  and symbols the way they are read, and break long sentences.
- Leave `voice` out to use the configured one. Name one only when the user
  asked for it.
- Save the file where the project keeps its audio and give it a name that
  says what it is. Without a `path` it goes under `.cline/generated-audio/`.
- You do not hear the result. Say what you asked for, where the file is and
  how long it is, and let the user listen.
- For a long text, make one file per section. A section that came out wrong
  can then be made again alone.
