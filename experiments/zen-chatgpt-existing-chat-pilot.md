# Existing ChatGPT conversation in a private Zen window

Status on 30 September 2026: authenticated read and persisted write measured
against the person's account, with no completed model reply. The person's
desktop, browser window, pointer, and keyboard were not controlled.

The managed Orbit broker created a private Fedora display. `launch-app zen`
copied the active profile into that display with a `public-web` network lease.
The snapshot reported 14,561 files, 1,696 validated SQLite databases, and
1,173,270,272 logical bytes. In the private window, `chatgpt.com` showed the
account's recent conversations. One existing conversation body loaded. A
separate conversation already used for a numeric test was opened, and one
short Orbit test message was submitted there. The message remained visible
after a browser reload, so the write reached persistent account history.

The UI initially reported `Hmm...something seems to have gone wrong` instead
of an assistant answer. After reloading, the same message remained and the
assistant response indicator continued without a completed answer until the
private session stopped. No second message or retry was sent. The Orbit
journal recorded no blocked origin or refused network authority, which does
not prove that every request to the service succeeded. The private Zen
process exited after `session.stop`; Orbit listed both pilot sessions as
closed. No frame containing conversation content was retained as a file.

A local proxy fixture then sent two delayed response chunks through the same
`public-web` CONNECT tunnel class. Both chunks reached its client in order;
`tests/egress.test.ts` passed 21 tests. This rules out an immediate close of
every streamed CONNECT response in the tested transport path. It does not
identify the ChatGPT request, response status, or reason for the model error.

This supports authenticated access to current ChatGPT conversation history
and persistence of one user turn from the private display. It does not support
a claim that Orbit can complete a model turn in an existing ChatGPT
conversation, recover from the observed error, refresh account tokens, or
remain synchronized with a simultaneously running owner browser. The host
Zen process was absent before this pilot, so coexistence was not measured.
