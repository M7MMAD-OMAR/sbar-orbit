# Native platform evidence

Updated 22 October 2026.

Historical browser measurements do not certify the current native-only product.
See [actual platform support](support-tiers.md), [the real native opening report](native-opening.md)
and [the native adapter contract](porting.md). Opening on Windows and macOS is
not implemented. Native input and capture on the measured Wayland adapter follow actual plugin
source and compositor ABI checks; the historical hold is retired. Git history retains
retired implementation measurements.

## Windows adapter and real acceptance requirements

Windows discovery and service infrastructure do not provide native desktop
control. The current implementation has App Paths metadata, a per-user broker
endpoint, logon task registration and resource-budget infrastructure. Native
opening, target-bound input, capture, activity overlay and numbered workspace
presentation still require a Windows adapter. Removing a platform check cannot
implement those operations. No Windows native application acceptance is claimed.

The shared broker, action policy, request identity and lifecycle contracts can be
reused. A Windows adapter must preserve original installed application state,
verify exact window identity and geometry, perform normal exact closure and show
the existing activity design with an agent pointer. It must report actual OS
permissions and delivery uncertainty. It must not replace the owner's desktop,
copy a profile or silently move the owner to another workspace.

Background operation needs application-specific evidence. Supported Windows UI
Automation patterns can address controls, but support depends on the application
provider. Global input injection is not proof of background, target-bound input;
it also has OS integrity restrictions. The documented virtual desktop API does
not establish arbitrary programmatic workspace management. See
[Microsoft control patterns](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-controlpatternsoverview),
[SendInput restrictions](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)
and [Microsoft virtual desktop guidance](https://devblogs.microsoft.com/oldnewthing/20201123-00/?p=104476).

Acceptance must run on a real supported Windows host and record the exact OS,
source and adapter versions. Exercise Win32 and packaged applications, original
browser state only when explicitly requested, multiple monitors and mixed DPI,
visible workspace presentation, owner focus and pointer preservation, shared
clipboard, Arabic input, save dialogs, pause and resume, stale window identities,
application exit, uncertain delivery, exact cleanup and update installation.
Keep unsupported and unmeasured operations explicit. A build, installer or service
fixture cannot certify this application workflow.
