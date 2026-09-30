# Nextcloud account and Talk in a private Chromium copy

Status on 30 September 2026: the person's Nextcloud account, file list, and
existing Talk conversation were visible through Orbit's private Chromium
browser backend. One message to the account's own "Note to self" conversation
appeared after submission. A later fresh private copy displayed that same
message, and it remained after reloading the conversation. Earlier Talk loads
had shown a blank page, so load reliability remains limited.

`orbit_profiles` reported the installed system Chromium profile as clonable.
Orbit created a private browser session from a copy with extensions disabled
and origins limited to the Nextcloud and Masaar GitLab hosts. The private
browser navigated to the Nextcloud dashboard without a login prompt. The
dashboard showed the account greeting, recommended files and Talk mentions.
The Files app then showed the account's All files list and existing folders.
The host Nextcloud Desktop sync client remained active. No second sync client
was started, and no host browser window or pointer was controlled.

The Talk app showed the person's existing conversation list and a warning
that this browser was not fully supported. A policy allowing only read and
navigate denied a `click` on a conversation because Orbit classifies clicks
as writes. After closing that session, a second private copy with the write
class allowed opened the existing "Note to self" conversation and displayed
its older messages. A short Arabic Orbit test message was entered and sent to
that self conversation. It appeared in the message timeline and the sidebar
with the current time. No other conversation received a message.

A direct navigation back to Talk after the send displayed only its blank
loading background. A fresh third Chromium copy authenticated to the
dashboard, but Talk again displayed a blank page. The session journals
recorded no blocked Nextcloud origin. At that stage, persistence and repeated
Talk use were unverified. The first private session, the send session, and the fresh check session
were stopped. No screenshot containing account content was retained as a
file.

This is stronger account evidence than the separate Zen website pilot, which
showed a Nextcloud login form. It proves authenticated browser access to the
existing file list and one observed Talk send from an independent display. It
does not prove native Nextcloud Desktop authentication or full device parity.
The later follow-up below verifies message persistence. The file test measures live
sync and one small web file write.

## Talk persistence follow-up

Later on the same day, a fresh private Chromium copy opened the Talk app and
displayed its conversation list. Its navigation action exceeded the 15 second
deadline, but the subsequent frame showed the loaded UI. Orbit stopped that
read-only session and created another copy allowing the click action needed
to open a conversation. Talk loaded there in about 13 seconds. Opening
"Note to self" displayed the earlier Orbit test message with its original
timestamp. Reloading that conversation route again displayed the same
message. No new message was sent. Both private sessions closed, and no frame
containing conversation content was retained as a file.

This verifies persistence of the one self message across a fresh private
profile copy and a page reload. The earlier blank loads remain recorded
failures, and their cause was not identified. The unsupported-browser warning
was still present. Message attachments, calls, microphone and camera access,
other conversations, and reliable loading across repeated sessions remain
unmeasured.

## Navigation deadline regression

The loaded Talk page after a navigation deadline prompted a separate local
fixture investigation. A complete HTML document contained one image whose
response remained open. With the original `page.goto` default load wait,
both Orbit `navigate` and URL-bearing `open-tab` failed with
`DEADLINE_EXCEEDED`. The regression ran before the fix: 0 pass, 2 fail in
31.70 seconds. The image fixture's idle timeout was explicitly longer than
the browser deadline.

Both actions now wait for `DOMContentLoaded`. The same fixture then returned
success and read the expected document text while the image and window load
event remained pending. The navigation, tab and personal-browser tests passed
9 tests. Type checking passed, and the standard suite passed 563 tests with
45 skipped and no failures across 126 files. The regression is
`tests/browser-navigation.test.ts`.

This fixes the measured wait on a pending nonessential image. It does not
identify which request delayed the earlier Talk page or explain its blank
loads. Navigation success still requires inspecting the application's state
before claiming it is ready.

After restarting the managed broker with this change, a fresh read-only
Chromium clone still returned `DEADLINE_EXCEEDED` for the Talk app in about
15 seconds. The next frame showed the signed-in Talk home and conversation
list. The launcher resolves to this checkout and starts its `src/cli.ts`, so
this was a run of the changed implementation. The session closed. This
preserves the live failure: changing the image load wait alone did not resolve
Talk's navigation deadline, and document readiness or a different navigation
stage still needs investigation.

## Shared file sync in both directions

A later pilot used another private Chromium copy while the original Nextcloud
Desktop client remained active. The client's existing configuration was read
only to identify its local sync root; it mapped the account root and was not
paused. No credential or unrelated file content was read. In the private
Files app, Orbit created a uniquely named blank Markdown document, wrote the
marker `Orbit private display sync probe. 2026-09-30.`, and saw it in the
editor. The original client's local sync root contained the same file with
the exact marker bytes. Orbit then unlocked its own test document, deleted
that file through the private Files UI, and confirmed the file disappeared
from the local sync root. The private session closed.

For the reverse direction, a separate temporary text file with a unique name
was created in the local sync root using exclusive creation. A fresh private
Chromium copy showed it in the signed-in Files list. Removing that exact
local test file made the Files search return no result after reload. The
private session closed. Both temporary filenames were absent locally at the
end, and the original Nextcloud Desktop process was still running.

These two disposable file paths demonstrate bidirectional propagation
between the private account browser and the person's original sync client on
this workstation. They do not establish how concurrent edits to one file are
resolved, large-file behavior, selective sync of other folders, account token
refresh, or hardware device access. The Markdown marker was verified in the
local file. The reverse-direction text file was verified by name in the web
list, not by opening its content in the web editor.

Two further private browser copies checked whether Chrome offered another
authenticated Talk route. The installed system Chrome profile and the Flatpak
Chrome profile both redirected the Nextcloud dashboard to its login page, so
neither provided an existing Nextcloud session. Both private sessions closed.
This leaves system Chromium as the measured authenticated browser profile for
this service on the current workstation. It does not explain the blank Talk
page after reopening it.
