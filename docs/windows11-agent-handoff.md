# Windows 11 testing-agent handoff

## Scope and honest baseline

Use an owner-operated, interactive Windows 11 x64 laptop to reproduce defects and file GitHub issues. This is a testing handoff, not permission to publish, push changes, repair an installation, or connect remotely to another computer.

- Repository: [M7MMAD-OMAR/sbar-orbit](https://github.com/M7MMAD-OMAR/sbar-orbit), branch `main` only. No branches or worktrees.
- Reviewed functional baseline: `0c53b8e182817ff990e129414d11dc51523bff42`. Record the actual tested HEAD; later documentation commits do not retroactively become the tested baseline.
- Source version: `0.4.3`, an unpublished candidate. Published stable remains `0.4.2`. Do not create a release, tag, package, public binary upload, or signing claim.
- Baseline source verification: strict TypeScript passed; 562 tests passed, 5 platform skips, 0 failures, 3102 assertions across 60 files. These are source tests, not Windows GUI acceptance.
- Actual Windows run [41780007115](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/41780007115) built native helpers, GUI and Setup, and passed public no-Bun payload checks, source/dependency/runtime integrity, explicit runtime acquisition and negative unknown-root refusal. Positive installation still failed at `health` with `broker-not-ready`, central exit `1`.
- GUI/window acceptance, installed dependency-tamper sentinel, persistent native MCP activation, rollback, automatic-update operation and outside-root uninstall remain unproven. An old diagnostic pure ownership predicate returning false is not a measurement of the newer live semantic predicate.
- Windows original-application control is unsupported. A WinForms/WebView2 management window is not permission or evidence for controlling other Windows applications.

Read the local home instructions, [repository instructions](../AGENTS.md), [product contract](desktop-only.md), [dated acceptance evidence](acceptance.md), and [Windows packaging contract](../packaging/windows/README.md). The repository instructions describe Graft navigation. Its index is generated locally and is not a committed checkout file; do not assume it is present or install an unreviewed tool to obtain it. Record unavailable navigation tooling and follow the host-approved source inspection workflow. Historical experiments are not automatically supported production interfaces.

## Safety and prerequisites

1. Work visibly in the owner-approved interactive account. Preserve unrelated windows, unsaved documents, pointer, focus and conversation off. SSH or a headless session cannot prove visible GUI behavior. Use only owned application windows for screenshots.
2. Use Bun only, not npm or npx. Use the official pinned Bun `1.4.4` archive in an owned tools directory, verified against [build pins](../desktop/windows/build-pins.json), including archive and executable metadata. Do not install global Bun, replace another Bun, copy a profile, or fetch an unreviewed executable. Ask the owner to provision missing prerequisites normally.
3. GUI compilation requires .NET SDK `10.0.403`, runtime pin `10.0.14`, and WebView2 SDK `1.0.4314.35`. The [SDK selector](../desktop/windows/global.json) disables roll-forward. WebView2 Evergreen is a separate installed prerequisite for running the GUI. Missing prerequisites are a reported limitation, not permission for silent global installation.
4. Keep NuGet locked restore and signature/hash verification. Raw signed package SHA-512 and NuGet content hash are different qualified values. Never disable verification or edit locks to make a restore pass.
5. Run one budgeted command at a time. Use the [Windows preflight](../packaging/windows/preflight.ps1) and [resource limiter](../scripts/limited.ts); stop on resource refusal. Preflight requires at least the larger of 3 GiB and 40 percent of physical RAM free, CPU load at most 85 percent, and caps .NET workers at 2. Reserve at least 4 GiB free disk for build work. Do not close owner programs or delete files to satisfy a reserve.
6. Never disable Defender, SmartScreen, UAC, execution policy or other security controls. Unsigned builds do not have publisher authentication. Do not bypass a warning to run an artifact whose source and provenance are unverified.
7. Preserve `%LOCALAPPDATA%\sbar-orbit\managed`, existing tasks, current pointers, recovery barriers and unknown files. Do not clear a barrier, recursively delete a root, prune versions, force task creation, kill/restart a shared broker, or run cleanup to hide a failure. Do not adopt a foreign task because its name or description looks familiar.
8. GitHub access must use this laptop owner's own `gh` authentication. Never copy credentials, cookies, tokens, environment dumps, application profiles or keys from another machine. Do not echo authentication secrets.

## Start with source checks

The following are PowerShell commands for the Windows agent, not evidence that this handoff author ran them. Use a fresh, owner-approved clone destination. Do not overwrite an existing checkout or reset local work.

```powershell
$ErrorActionPreference = "Stop"
git clone --branch main --single-branch https://github.com/M7MMAD-OMAR/sbar-orbit.git
if ($LASTEXITCODE -ne 0) { throw "Fresh clone failed; preserve existing files" }
Set-Location sbar-orbit
git status --short
git rev-parse HEAD
git merge-base --is-ancestor 0c53b8e182817ff990e129414d11dc51523bff42 HEAD
if ($LASTEXITCODE -ne 0) { throw "Checkout does not contain the reviewed baseline" }
```

Record Windows version/build and architecture, tool versions, free memory/disk and resource refusal categories. Do not publish hostnames, account names, SIDs, serial numbers, paths or full system inventories. Read home instructions before acting:

```powershell
$ErrorActionPreference = "Stop"
$homeInstructions = Join-Path $HOME AGENTS.md
if (Test-Path -LiteralPath $homeInstructions) { Get-Content -LiteralPath $homeInstructions }
Get-Content -LiteralPath .\AGENTS.md
$Bun = Read-Host "Absolute path to the already verified private Bun 1.4.4 executable"
$Bun = (Resolve-Path -LiteralPath $Bun -ErrorAction Stop).Path
$actualBunVersion = (& $Bun --version).Trim()
if ($LASTEXITCODE -ne 0 -or $actualBunVersion -ne "1.4.4") { throw "Verified pinned Bun is unavailable" }
# This changes only the current process, not the machine or user profile PATH.
$env:PATH = (Split-Path -Parent $Bun) + [IO.Path]::PathSeparator + $env:PATH
& .\packaging\windows\preflight.ps1
& $Bun run scripts/limited.ts $Bun install --frozen-lockfile --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw "Frozen dependency installation failed" }
& .\packaging\windows\preflight.ps1
& $Bun run scripts/limited.ts $Bun run typecheck
if ($LASTEXITCODE -ne 0) { throw "Typecheck failed" }
& .\packaging\windows\preflight.ps1
& $Bun --smol run scripts/verify-desktop.ts
if ($LASTEXITCODE -ne 0) { throw "Source verification failed" }
```

The last command is the actual target of the package verification script. Report actual Windows counts and skips, not the Linux baseline counts. Do not replace resource limits with an uncapped run. The website is a separate workspace; if a check requires its dependencies, report that prerequisite and follow its frozen Bun workflow rather than blaming an unrelated native adapter.

## What local compilation can honestly prove

The [build/acceptance driver](../packaging/windows/build.ps1) explicitly requires a dedicated hosted GitHub Actions account. The [acceptance helper](../scripts/windows-desktop-acceptance.ts) also requires actual Windows plus `GITHUB_ACTIONS=true`. Those guards are real boundaries.

**Do not set `GITHUB_ACTIONS`, `RUNNER_TEMP`, diagnostic-admission variables or other hosted identity flags to impersonate CI. Do not remove a guard or copy a CI profile.** There is currently no qualified local full-Setup acceptance driver in this handoff. If that blocks testing on the laptop, file a supported-local-driver issue with sanitized evidence. Do not call the hosted-only refusal a successful installer test.

A narrower local GUI compile is available through the actual [desktop project](../desktop/windows/Orbit.Desktop.csproj). After prerequisites, source checks and disk/resource checks pass, the following mirrors locked restore and publish flags without invoking the hosted driver. It produces an owned, unpublished compile output only:

```powershell
$ErrorActionPreference = "Stop"
$Repo = (Get-Location).Path
$version = (Get-Content -LiteralPath .\package.json -Raw | ConvertFrom-Json).version
$Output = Join-Path ([IO.Path]::GetTempPath()) ("orbit-local-gui-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $Output -ErrorAction Stop | Out-Null
& .\packaging\windows\preflight.ps1
Push-Location .\desktop\windows
try {
  dotnet --version
  if ($LASTEXITCODE -ne 0) { throw "Pinned SDK unavailable" }
  & $Bun run (Join-Path $Repo scripts/limited.ts) dotnet restore Orbit.Desktop.csproj --locked-mode --runtime win-x64 --disable-parallel
  if ($LASTEXITCODE -ne 0) { throw "Locked GUI restore failed" }
  & $Bun run (Join-Path $Repo scripts/limited.ts) dotnet publish Orbit.Desktop.csproj -c Release -r win-x64 --self-contained true --no-restore --maxcpucount:2 "-p:Version=$version" "-p:PublishDir=$Output/"
  if ($LASTEXITCODE -ne 0) { throw "GUI publication to owned local directory failed" }
} finally { Pop-Location }
```

Compilation is not Setup, runtime acquisition, a prepared source seal, task registration, successful doctor identity, a visible native window, MCP, or update acceptance. Do not run a naked compile output as if it were a selected managed installation, manufacture its seal, or weaken admission. Missing local native-helper/installer integration is an issue to report, not permission to invent a wrapper or copy a global runtime into the payload.

If the owner separately supplies an explicitly authorized, reviewed private installer, first establish its exact source revision and SHA-256 without publishing the binary. Test only the normal supported flow in the visible interactive account, with explicit runtime-download or exact-archive consent. Keep public payloads Bun-free. Stop at any unknown-root/task/security/prerequisite refusal. Preserve any failed transaction and report it. Do not continue to GUI, tamper, activation, rollback or uninstall steps until the preceding real prerequisites pass and a supported procedure exists. Do not run tamper injections or destructive cleanup on the owner's installation.

A meaningful manual observation records actual installer and helper exits, fixed diagnostic phase/code when available, visible owned management window behavior, and exact doctor identity if genuinely available. A process launch, screenshot alone, empty task query, registered task, old pure ownership diagnostic, or command returning success is insufficient proof of a healthy installed system. Never infer startup cause from a last-task result observed after failure cleanup stopped the task.

## File a useful GitHub issue

Use the existing [platform report form](https://github.com/M7MMAD-OMAR/sbar-orbit/issues/new?template=02-platform-report.yml) for Windows setup, build or platform support, or the existing [measured bug form](https://github.com/M7MMAD-OMAR/sbar-orbit/issues/new?template=01-bug-measured.yml) for a reproduced operation failure. The checked-in [platform template](../.github/ISSUE_TEMPLATE/02-platform-report.yml) and [measured bug template](../.github/ISSUE_TEMPLATE/01-bug-measured.yml) define the reporting contract; do not invent a competing issue form. With `gh issue create --body-file`, structure the body under the applicable existing form headings and include the extra Windows evidence below.

Reproduce once when safe. Stop rather than repeating a side effect or changing the system to hide the problem. Search [existing issues](https://github.com/M7MMAD-OMAR/sbar-orbit/issues) first, especially `broker-not-ready` and local Windows acceptance support. Add evidence to an existing issue when it is the same defect; do not claim that a new machine proves the same root cause.

```powershell
gh auth status
gh issue list --repo M7MMAD-OMAR/sbar-orbit --state open --search "Windows broker-not-ready"
# Prepare a reviewed, sanitized issue body in this owned local text file first.
gh issue create --repo M7MMAD-OMAR/sbar-orbit --title "[Windows 11] Concise reproducible failure" --body-file .\windows11-issue.md
```

The platform form deliberately makes its capability report optional when Orbit did not start. Say "unavailable" and give the observed refusal; do not launch a new broker or invent a doctor report to fill the field.

For a CLI body, keep these existing platform form headings: Host class, Result, Capability report (if available), and What you ran and what it did. Add the following details under them.

Issue body checklist:

- Exact tested commit, branch, dirty/clean status, candidate version and related run/issue links.
- Windows 11 build and architecture; Bun/.NET/WebView2 versions; resource reserve numbers only. State which prerequisites were unavailable.
- Whether the session was truly interactive. Which supported path was used: source tests, local compile, or separately authorized private Setup.
- Minimal exact commands with account/path/token values replaced by placeholders. Expected result, actual observation, actual exit codes and fixed phase/reason. Mark unmeasured fields unknown.
- Existing root/task/recovery barrier presence as booleans only. Preserve unknown state; explain that no cleanup, permission bypass, timeout change or broker restart was attempted.
- Small, manually reviewed JSON made only of approved fixed enums, numbers and booleans. No raw task XML, command/environment dump, SIDs, account aliases, private paths, tokens, stack traces, private profiles, unredacted logs or screenshots of other applications. Owned app screenshots must be reviewed for accidental private content before attachment.
- Separate observed failure from hypotheses and from historical CI evidence. Include a safe reproduction boundary and any proposed follow-up that needs explicit owner approval.

Finish by reporting tested SHA, commands and actual results, issue URLs, untested gates, preserved state and temporary artifacts left behind. Do not push source changes, publish binaries, release packages or perform remote control. The maintainer will review issues and coordinate later repairs.

## Copyable Arabic prompt for the Windows 11 agent

```text
أنت وكيل اختبار على لابتوب Windows 11 الخاص بي. المطلوب استنساخ M7MMAD-OMAR/sbar-orbit على main، اختبار ما تدعمه الشيفرة فعليا، ثم توثيق الأعطال كـ GitHub Issues. لا تعمل على جهاز Linux الآخر ولا تنشئ اتصالا عن بعد. لا تدفع تغييرات ولا تنشر إصدارا أو ملفات تنفيذية.

اقرأ تعليمات AGENTS.md في مجلد المستخدم وفي المستودع، ثم docs/windows11-agent-handoff.md وعقد المنتج. خط الأساس المراجع هو 0c53b8e182817ff990e129414d11dc51523bff42. سجل SHA الحقيقي الذي تختبره ولا تنسب نتائج قديمة إليه. المصدر 0.4.3 مرشح غير منشور، والمستقر 0.4.2. اختبارات المصدر السابقة نجحت 562 مع 5 تخطيات، لكن تثبيت Windows الحقيقي ما زال يتوقف عند health بسبب broker-not-ready. لم يثبت نجاح الواجهة أو MCP والتحديث والتراجع بعد. التحكم بالتطبيقات الأصلية على Windows غير مدعوم.

استخدم Bun فقط من نسخة رسمية خاصة متحقق من بصماتها، دون تثبيت Bun عاما أو نسخ ملفات تعريف. نفذ فحص الموارد والأوامر المحدودة بالتتابع، أمرا واحدا في كل مرة. حافظ على تحقق NuGet والأقفال وإصدارات الأدوات المثبتة. لا تغلق برامج المستخدم ولا تقتل أو تعيد تشغيل وسيط مشترك لتوفير الموارد.

لا تعطل Defender أو SmartScreen أو UAC أو سياسة التنفيذ. لا تحذف مجلدا مجهولا أو مهمة موجودة أو حاجز استرداد. لا تفرض الاستيلاء على مهمة لمجرد تشابه الاسم أو الوصف، ولا تنسخ مفاتيح أو رموز دخول أو إعدادات من جهاز آخر. احترم conversation off واحفظ النوافذ والعمل غير المحفوظ والمؤشر والتركيز. أي تصوير يقتصر على نافذة التطبيق التي نختبرها بعد التأكد من خلوها من بيانات خاصة.

اتبع قسم الفحوص والبناء المحلي في الوثيقة. مسار البناء والقبول الكامل الحالي مخصص لـ GitHub Actions، فلا تزور GITHUB_ACTIONS أو RUNNER_TEMP أو أعلام صلاحية التشخيص لتجاوزه. إذا لم يوجد مسار محلي مدعوم، افتح Issue واضحا بهذا القصور ولا تخترع نجاحا أو صلاحية. نجاح ترجمة مشروع الواجهة لا يعني نجاح التثبيت أو ظهور نافذة أو صحة الوسيط. لا تنفذ اختبارات عبث بالاعتماديات أو تراجع أو إزالة مدمرة على تثبيتي.

استخدم جلسة سطح المكتب التفاعلية المرئية التي أذنت بها فقط. SSH أو عملية تعمل في الخلفية لا يثبتان الواجهة. استخدم مصادقة gh الخاصة بهذا الجهاز دون كشف أسرار، وابحث عن Issues مشابهة قبل إنشاء واحدة. في كل Issue ضع SHA وإصدار Windows والأدوات والموارد وخطوات إعادة الإنتاج والنتيجة المتوقعة والفعلية وأكواد الخروج ومرحلة الفشل الثابتة إن توفرت. لا ترفق XML أو SID أو أسماء حسابات أو مسارات خاصة أو متغيرات بيئة أو سجلات خام أو أسرارا. افصل الحقيقة عن التخمين ولا تضع unknown كأنه نجاح.

اختم بتقرير موجز: SHA المختبر، ما نفذته فعليا ونتائجه، روابط Issues، ما لم يختبر، والحالة والملفات المؤقتة التي أبقيتها محفوظة. عند وجود مانع سجل دليلا منقحا وتوقف دون تجاوز الحماية.
```
