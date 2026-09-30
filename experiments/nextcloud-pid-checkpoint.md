# Nextcloud private PID namespace checkpoint

Stopped at the user's request on 1 October 2026. Further account, application,
network and device investigation is suspended at this checkpoint.

## Evidence retained from 30 September

- The installed private Nextcloud process had namespace depth 2 and namespace
  PID 2. Its PID namespace differed from the harness, its proc init was present,
  and the harness process was absent from its proc mount.
- An offline control using the old host namespace failed the new namespace gate.
- Initial native file synchronization did not pass. No namespace account parity
  or successful private namespace file lifecycle is claimed.
- The same connection failure occurred without the PID namespace. The new tunnel
  counters identified an upstream TCP connection timeout before an accepted
  tunnel or TLS payload. A direct IPv4 check also timed out. The interrupted
  IPv4 and IPv6 check has no retained result and is not measured.
- Generated remote test collections were removed and their absence confirmed.
  Failure reports recorded unchanged original configuration and the continued
  presence of the original Nextcloud process. This does not prove that all
  original application state was unaffected.

## Changes saved

The experiment has an opt-in PID namespace flag and a process-directory-pinned
namespace check. Failure evidence retains counts and booleans, not raw account
logs or credentials. Initial upload and download must pass before lifecycle
operations are attempted. A private temporary directory keeps application
scratch and singleton paths inside the owned experiment root. The upstream
connection counter now distinguishes client-header, upstream-connect and
established tunnel I/O failures. Deadlines and allowed account authority are
unchanged. The cause of the earlier startup retry loop is not established.

Typecheck passed at this checkpoint. These files remain experimental and are
not integrated into production application launches. The full goal of using
all existing applications, accounts, conversations, files and devices on an
independent display remains incomplete.
