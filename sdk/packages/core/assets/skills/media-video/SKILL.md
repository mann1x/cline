---
name: media-video
description: >-
  Makes short video clips from a description or from a starting image. Use
  when the user asks for a video, a clip, an animation of an image, a
  background loop, a product shot or placeholder footage.
---

# Video

You can make a short clip yourself with `generate_video`. Do not send the user
elsewhere for a few seconds of footage.

When you do not have `generate_video`, it is not set up. Say that the user
turns it on in **Settings > API Configuration > Video**, and stop there.

## What it does well, and what it does not

It makes one scene of a few seconds: a subject, a movement, a camera. It does
not follow a storyboard, does not write legible text, and does not record the
application.

| Wanted | Do |
|---|---|
| A background loop, a product shot, an atmospheric clip | `generate_video` |
| A still picture brought to life | `generate_video` with `image` |
| A demo of the application in use | Not this tool. Offer screens made with `render_image`, or say the user has to record it |
| A clip with a title or captions in it | Generate the footage without text and say the text has to be added in an editor |

## Making a clip

1. Write the `prompt` as one scene: what is in it, what moves and how, what
   the camera does, the style and the light. "A paper plane glides left to
   right over a blue desk, slow push-in, soft daylight, flat illustration."
2. To control how it looks, make the first frame as a picture first
   (`generate_image`, or `render_image` for anything with text or structure)
   and pass it as `image`. Only some video models accept one; the reply says
   so when it does not.
3. Leave `size` and `seconds` out unless the task needs them. The backend
   supports only a few shapes, and length costs more than proportionally.
4. Give a `seed` when the user may want the same clip again with one change.

A clip takes from most of a minute to many minutes, and on a hosted backend
it costs money. Make one, tell the user where it is and let them judge it:
you cannot watch it. Do not make another to "improve" one nobody has said is
wrong.

## After making one

Save it where the project keeps its media, with a name that says what it
shows; without a `path` it goes under `.cline/generated-videos/`. To show it
in a README, link the file. Most renderers do not play an embedded video from
the repository.
