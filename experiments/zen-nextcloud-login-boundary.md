# Nextcloud sign-in and Zen origin boundary

Status on 30 September 2026: a private Zen copy reached the person's Nextcloud
server, but it did not have an authenticated website session. No file contents
or sync operation were measured. A network policy defect was reproduced and
fixed in source, with a local proxy test. The installed broker has not yet
been updated to this source revision.

The host Nextcloud Desktop client remained active throughout the pilot. Its
configuration was read only to obtain the server hostname. No password, token,
sync directory, or local file was copied or printed. Orbit created one Fedora
display and launched `zen` with `profile: active`, `network: public-web`, and
session origins containing only `https://nxcloud.masaar.com`. The private Zen
window displayed the Nextcloud login form. Its Masaar GitLab button navigated
to `gl.team.masaar.com`, where another login form appeared. Neither website
showed an existing signed-in session. No credentials were entered and no
account write was made. The private Orbit session was stopped; the host sync
client stayed active. The source profile was not deliberately changed.

The GitLab navigation was also a policy test. The running broker's
`public-web` proxy checked that destinations were public IP addresses but did
not compare them with the session's origin list. Its journal showed the
Nextcloud-only policy and recorded no refused authority while the GitLab form
loaded. The source now passes the live session origin list to the private Zen
lease. Plain HTTP checks the exact origin. HTTPS CONNECT checks the allowed
host and port before DNS. A session with no named origins cannot launch Zen
in `public-web` mode. A narrowing of the live policy is read on each proxy
request. Local tests confirm that another host, another port, and a previously
allowed host after narrowing return 403 before DNS. This still cannot inspect
TLS SNI or the encrypted HTTP origin inside an allowed CONNECT tunnel.

The account acceptance target remains open. Browser profile copying did not
reuse the native Nextcloud client's authentication. A second sync client was
not started against the person's folder. A live test after updating the
managed broker, plus authenticated file access and coexistence checks, is
still required before this route can be claimed for Nextcloud.
