# Native keyboard reliability investigation

Investigation date: 26 October 2026. Scope: the Hyprland keyboard transport and
prepared key and text handlers. This report contains no account identifiers,
verification codes, private screenshots or user input text.

## Reproduced defects and source repairs

Modifier parsing previously accepted only `ctrl`, `shift`, `alt` and `super`
with that exact case. `CTRL+l` and `Control_L+l` reached the compositor and were
rejected. Modifiers now accept case-insensitive canonical names and the explicit
left and right XKB names, including `Control_L`, `Shift_R`, `Alt_L` and `Super_R`.
Left and right aliases select the corresponding logical modifier, not a physical
device or a side-specific hardware key.

A rejected key or text payload could leave its keyboard preparation pending.
The next operation then received `another keyboard operation is pending` until
cleanup, expiration or handback. Two layers now handle this:

1. The plugin consumes the matching prepared operation before validating its
   key or text payload. Invalid input sends no keystrokes and does not retain
   that operation. A different operation token cannot consume it.
2. The Python transport attempts token-bound cancellation in `finally`, including
   after a commit attempt. This also cleans up a rejection from an older plugin.
   Cancellation sends no input. A failed or uncertain commit is never replayed.
   The existing absolute deadline and server expiration remain in effect.

The regression checks execute the actual key and text C++ handlers in a compiled
fixture and exercise the Python transport through local Unix sockets. They fail
against the original source for modifier aliases and retained rejected key/text
operations. These are source and protocol measurements, not a completed browser
workflow or proof that a running installed plugin has been updated.

The normal verification suite includes `tests/native-transport.test.ts`, so the
socket rejection and no-replay checks are no longer confined to a manual run.

## Historical selection report and current native measurement

An original application workflow reported that selecting its address text and
then sending native text collapsed the selection and appended the new text.
Clearing the selection with BackSpace first was an observed workaround, not a
general repair. Automatically inserting BackSpace would destroy intentional
selections or existing content, so Orbit does not add it.

The current same-surface focus fixture checks that preparation does not resend
the keymap or keyboard enter when that resource remains enrolled and focused.
That fixture does not reproduce the complete application workflow. In particular,
it does not establish how an application reacts to per-operation XDG configure
events, popup transitions, owner input or a change of focused surface. No change
to those focus or configure paths is claimed as a selection fix here.

On 26 October 2026, the fix from commit `7274d69` was activated on the measured
Linux Hyprland 0.56.2 host. The loaded plugin reported source SHA-256
`1c680d1a0a2dd808b5c710aca05914c5c5680e8e89229f451ea2abbd3f6fd84d`.
Activation followed closed-session checks, broker update admission, a Wayland
input-idle notification and native unload readiness checks. The previous source
and preparation were retained for rollback. The broker was not restarted, and
update admission was released after the new loaded source was verified.

An original installed Chrome window was opened floating at 1080 by 740 logical
pixels on workspace 7, presented on an explicitly selected unfocused output.
Its normal existing profile was used without copying profiles or changing browser
security or detection settings. A local HTML document supplied single-line and
multiline fields with visible selection offsets and input event observations.
Input used Orbit native actions; no DOM control or browser automation backend
was used. Captures remained private.

The actual observations were:

- Selecting all 19 characters of `ORBIT_OLD_SELECTION` and typing
  `ORBIT_REPLACED` produced exactly that replacement, with caret offset 14.
- Selecting offsets 24 through 29 in `alpha ORIGINAL_SELECTED omega` and typing
  `RESULT` produced `alpha ORIGINAL_SELECTED RESULT`, with caret offset 30.
- `Control_L+l` visibly selected the local file address. Native text replaced it
  with `ORBIT_OMNIBOX_REPLACED`, without BackSpace in that replacement sequence.
  Return was not pressed, so the marker was not submitted as navigation.
- An intentionally invalid modifier was rejected. `CTRL+L` followed immediately
  by native text then succeeded in the same session, producing
  `ORBIT_AFTER_REJECT` in the address bar without a new handoff or session.

Initial loading of the local file used a cleared address field. That bootstrap
step is separate from the measured replacement sequence. Neither marker was
submitted. Existing owner window geometry and pointer coordinates were unchanged
in the baseline and post-opening samples. These are sampled observations, not a
continuous guarantee of owner state.

The reported selection collapse did not reproduce in these measured cases.
Its historical cause remains unestablished; the modifier and cleanup repair
must not be presented as proof of a general selection repair. A future recurrence
needs a bounded protocol trace and actual selection/caret observations around
surface, popup, configure and owner-input transitions before changing those paths.

On a later state check the test lease was already closed, and another task held
an active lease for the same Chrome client. Further input, pause/resume testing
and normal closure of the test window were not attempted under that lease.
Cleanup is therefore not a completed acceptance result. The outputs had also
changed, so the earlier output workspace was not forced back over the current
owner state. No other task's lease or windows were stopped to complete a test.

## Application acceptance and platform decisions

A native acknowledgement establishes protocol delivery, not completion of an
application action. Observe the actual application state after each material
step before continuing. An uncertain reply is a reason to inspect, not to repeat
typing, navigation, submission or publication blindly.

A platform challenge or account suspension occurring after an application task
does not establish that Orbit caused the platform decision. No platform reason
or causal link was verified in this investigation. No account login, publishing,
CAPTCHA, appeal, fingerprint modification or detection-evasion experiment forms
part of these checks. Human verification and platform restrictions stay with the
owner and the platform.

## Activation boundary

Source tests and an offline plugin build do not activate a fix. A changed plugin
requires a matching build, compositor ABI verification and an idle activation
boundary. Do not replace a loaded plugin or restart a shared broker while another
task has active work. Keep source verification, installed bytes and live native
application acceptance as separate reported facts.
