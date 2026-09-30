# Nextcloud account and Talk in a private Chromium copy

Status on 30 September 2026: the person's Nextcloud account, file list, and
existing Talk conversation were visible through Orbit's private Chromium
browser backend. One message to the account's own "Note to self" conversation
appeared after submission. Persistence after a reload or fresh copy was not
verified because subsequent Talk loads showed a blank page.

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
recorded no blocked Nextcloud origin. These observations do not establish
whether the message remained after reload, whether Talk supports a completed
second session on this browser, or whether the service's device features
work. The first private session, the send session, and the fresh check session
were stopped. No screenshot containing account content was retained as a
file.

This is stronger account evidence than the separate Zen website pilot, which
showed a Nextcloud login form. It proves authenticated browser access to the
existing file list and one observed Talk send from an independent display. It
does not prove native Nextcloud Desktop authentication, live sync, file writes,
message persistence after restart, or full device parity.
