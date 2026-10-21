# Existing application handoff

Owner input, capture and plugin activation are held after a compositor crash and
subsequent unproven input delivery. There is no runtime override.

See [the incident record](native-handoff-incident.md) for retained evidence and
release requirements. Opening an original application is independent of handoff;
see [real opening results](native-opening.md). Neither a new window nor a returned
IPC acknowledgement proves keyboard or pointer effects in that application.

Do not replace an existing application with a different profile or private session.
No current platform has certified general existing-application control.
