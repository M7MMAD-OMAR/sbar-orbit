# Windows port research: verified primary sources

Scope: what a Windows 10 1809+ / Windows 11 port of the Sbar Orbit broker can and
cannot rely on, checked against Microsoft Learn, the sdk-api source of that
documentation, Chromium source, libuv source, and the Node/Bun issue trackers.
Every claim carries the URL it came from. Anything not backed by a primary
source is labelled **not confirmed**.

Conventions used here: `IS` = `SetInformationJobObject`, `IQ` =
`QueryInformationJobObject`. Struct layouts marked "derived" were computed from
the documented field types under the x64 ABI, not quoted from a document.

---

## 1. Job Objects: calls, flags, layouts

### Creation and assignment

- `CreateJobObjectW(lpJobAttributes, lpName)`. With `lpJobAttributes == NULL`
  the job gets a default security descriptor whose ACLs come from the primary
  or impersonation token of the creator, and the handle is not inheritable.
  The returned handle has `JOB_OBJECT_ALL_ACCESS`. If a job of that name
  already exists the call returns a handle to it and `GetLastError()` is
  `ERROR_ALREADY_EXISTS`. Name is limited to `MAX_PATH` and is case sensitive;
  it shares a namespace with events/semaphores/mutexes/waitable timers/file
  mappings, so a collision fails with `ERROR_INVALID_HANDLE`.
  <https://github.com/MicrosoftDocs/sdk-api/blob/docs/sdk-api-src/content/jobapi2/nf-jobapi2-createjobobjectw.md>
  (rendered: <https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-createjobobjectw>)
- For the broker this argues for an **unnamed** job (no `lpName`), which cannot
  be opened by name by any other process, since `OpenJobObject` only works on
  named jobs. <https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects>
- `AssignProcessToJobObject` associates a process; once associated the
  association cannot be broken. Child processes created with `CreateProcess`
  are associated with the job by default (children created via
  `Win32_Process.Create` are not).
  <https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects>
- Race-free alternative to "spawn then assign": `PROC_THREAD_ATTRIBUTE_JOB_LIST`
  with `UpdateProcThreadAttribute`, `lpValue` being a list of job handles
  assigned to the child in the order specified, "Supported in Windows 10 and
  newer and Windows Server 2016 and newer".
  <https://github.com/MicrosoftDocs/sdk-api/blob/docs/sdk-api-src/content/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute.md>
  Note this requires `CreateProcessW` with `EXTENDED_STARTUPINFO_PRESENT`,
  which Node/Bun's `child_process` does not expose, so it needs native code.
- Nested jobs (a process in more than one job) exist from Windows 8 / Server
  2012; on Windows 7 and earlier a process belongs to at most one job.
  <https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs>
  Consequence for the port: if Chrome is launched by something already in a job
  (Windows Terminal, some CI runners, Docker), nesting is what keeps it working
  on supported OS versions.
- Breakaway: `CREATE_BREAKAWAY_FROM_JOB` (0x01000000) only works when the job
  sets `JOB_OBJECT_LIMIT_BREAKAWAY_OK`; if neither `BREAKAWAY_OK` nor
  `SILENT_BREAKAWAY_OK` is set, no process in the tree can escape, and a child's
  own `AssignProcessToJobObject` call will fail.
  <https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags>
  <https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects>
  For an isolation broker, set **neither** flag: containment over friendliness.

### `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`

Documented fields, in order:
`BasicLimitInformation` (`JOBOBJECT_BASIC_LIMIT_INFORMATION`), `IoInfo`
(`IO_COUNTERS`, documented as "Reserved"), `ProcessMemoryLimit` (`SIZE_T`),
`JobMemoryLimit` (`SIZE_T`), `PeakProcessMemoryUsed` (`SIZE_T`),
`PeakJobMemoryUsed` (`SIZE_T`).
<https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information>

`JOBOBJECT_BASIC_LIMIT_INFORMATION` fields, in order:
`PerProcessUserTimeLimit` (`LARGE_INTEGER`), `PerJobUserTimeLimit`
(`LARGE_INTEGER`), `LimitFlags` (`DWORD`), `MinimumWorkingSetSize` (`SIZE_T`),
`MaximumWorkingSetSize` (`SIZE_T`), `ActiveProcessLimit` (`DWORD`), `Affinity`
(`ULONG_PTR`), `PriorityClass` (`DWORD`), `SchedulingClass` (`DWORD`).
<https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information>

x64 offsets (**derived** from those field types under the x64 ABI, 8-byte
alignment for `SIZE_T`/`ULONG_PTR`/`LARGE_INTEGER`; not quoted from Microsoft):

| Struct | Field | Offset | Size |
|---|---|---|---|
| BASIC_LIMIT (64 bytes) | PerProcessUserTimeLimit | 0 | 8 |
| | PerJobUserTimeLimit | 8 | 8 |
| | LimitFlags | 16 | 4 |
| | *(padding)* | 20 | 4 |
| | MinimumWorkingSetSize | 24 | 8 |
| | MaximumWorkingSetSize | 32 | 8 |
| | ActiveProcessLimit | 40 | 4 |
| | *(padding)* | 44 | 4 |
| | Affinity | 48 | 8 |
| | PriorityClass | 56 | 4 |
| | SchedulingClass | 60 | 4 |
| EXTENDED (144 bytes) | BasicLimitInformation | 0 | 64 |
| | IoInfo (`IO_COUNTERS`, 6 × ULONGLONG) | 64 | 48 |
| | ProcessMemoryLimit | 112 | 8 |
| | JobMemoryLimit | 120 | 8 |
| | PeakProcessMemoryUsed | 128 | 8 |
| | PeakJobMemoryUsed | 136 | 8 |

`IO_COUNTERS` is six `ULONGLONG` fields (`ReadOperationCount`,
`WriteOperationCount`, `OtherOperationCount`, `ReadTransferCount`,
`WriteTransferCount`, `OtherTransferCount`), hence 48 bytes.
<https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-io_counters>

Flag values (from the Windows SDK headers as mirrored by mingw-w64 `winnt.h`,
values also stated in the Learn pages for the same constants):

| Flag | Value | Meaning / source |
|---|---|---|
| `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` | 0x00000008 | limits concurrent processes; uses `ActiveProcessLimit`. <https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information> |
| `JOB_OBJECT_LIMIT_PROCESS_MEMORY` | 0x00000100 | per-process committed-memory cap, uses `ProcessMemoryLimit`. same page |
| `JOB_OBJECT_LIMIT_JOB_MEMORY` | 0x00000200 | job-wide committed-memory cap, uses `JobMemoryLimit`. same page |
| `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` | 0x00002000 | "Causes all processes associated with the job to terminate when the last handle to the job is closed." same page |
| `JOB_OBJECT_LIMIT_BREAKAWAY_OK` | 0x00000800 | see above |
| `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` | 0x00001000 | see above |
| `JOB_OBJECT_LIMIT_JOB_MEMORY_HIGH` | 0x00000200 (alias of JOB_MEMORY) | used by notification/violation classes |
| `JOB_OBJECT_LIMIT_JOB_MEMORY_LOW` | 0x00008000 | notification-only low-memory limit |

Header values: <https://github.com/mingw-w64/mingw-w64/blob/master/mingw-w64-headers/include/winnt.h>
(`JOB_OBJECT_LIMIT_*` block). KILL_ON_JOB_CLOSE semantics are also restated in
`CreateJobObject` remarks: "if the job has the
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` flag specified, closing the last job object
handle terminates all associated processes and then destroys the job object
itself."
<https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-createjobobjectw>

Important nuance for `JOB_MEMORY`: it is a **committed virtual memory** limit,
not RSS/working set: "this member specifies the limit for the virtual memory
that can be committed for the job".
<https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information>
That is not the same quantity as a Linux cgroup `memory.max` (anonymous+page
cache RSS). A Chrome instance with many renderers commits far more than it
resides; a naive port of the Linux number will kill the browser. Size the
Windows limit independently.

### `JOBOBJECT_CPU_RATE_CONTROL_INFORMATION`

Layout: `DWORD ControlFlags` then a union of `DWORD CpuRate`, `DWORD Weight`,
and `struct { WORD MinRate; WORD MaxRate; }`. **Derived** x64 layout: 8 bytes
total, `ControlFlags` at 0, the union at 4, `MinRate` at 4 and `MaxRate` at 6.
<https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_cpu_rate_control_information>

Control flags (values quoted in the sdk-api source of that page):

- `JOB_OBJECT_CPU_RATE_CONTROL_ENABLE` = 0x1, required whenever
  `WEIGHT_BASED`, `HARD_CAP` or `MIN_MAX_RATE` is set.
- `JOB_OBJECT_CPU_RATE_CONTROL_WEIGHT_BASED` = 0x2; uses `Weight`; mutually
  exclusive with `MIN_MAX_RATE`.
- `JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP` = 0x4: "After the job reaches its CPU
  cycle limit for the current scheduling interval, no threads associated with
  the job will run until the next interval." Mutually exclusive with
  `MIN_MAX_RATE`.
- `JOB_OBJECT_CPU_RATE_CONTROL_NOTIFY` = 0x8.
- `JOB_OBJECT_CPU_RATE_CONTROL_MIN_MAX_RATE` = 0x10; uses `MinRate`/`MaxRate`;
  mutually exclusive with both `WEIGHT_BASED` and `HARD_CAP`.

<https://github.com/MicrosoftDocs/sdk-api/blob/docs/sdk-api-src/content/winnt/ns-winnt-jobobject_cpu_rate_control_information.md>

Semantics, quoted:

- `CpuRate`: "Specifies the portion of processor cycles that the threads in a
  job object can use during each scheduling interval, as the number of cycles
  per 10,000 cycles... Set CpuRate to a percentage times 100. For example, to
  let the job use 20% of the CPU, set CpuRate to 20 times 100, or 2,000." A
  `CpuRate` of 0 makes `SetInformationJobObject` return `INVALID_ARGS`.
- `Weight`: 1..9, default 5, relative share versus other jobs.
- `MinRate`: reservation, percent × 100; "the sum of the minimum rates for all
  of the job objects in the system cannot exceed 10,000".
- `MaxRate`: cap, percent × 100; "After the job reaches this limit for a
  scheduling interval, no threads associated with the job can run until the
  next scheduling interval."

Same source page.

**Per-core or per-machine?** The documentation phrases every rate as "the
portion of processor cycles" for the whole system, and explicitly says that a
job with no rate-controlled ancestor gets "the portion of the CPU for the
entire system": "If a job object does not have a parent with CPU rate control
turned on in the chain of its parent jobs, the rate control for the job
represents the portion of the CPU for the entire system." So 20% means 20% of
total machine CPU capacity, not 20% of one core, and unlike a Linux
`CPUQuota=200%` there is no way to express "two cores' worth" other than as a
fraction of the whole machine. <https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_cpu_rate_control_information>
(Remarks.) Nested rate control composes multiplicatively: "the rates set for
the job represent its portion of the CPU rate that is allocated to its parent
job." Same page.

**Heterogeneous P/E core machines (Alder Lake and later):** Microsoft's job
object documentation says nothing about hybrid scheduling, efficiency cores, or
how "cycles per 10,000 cycles" is normalised when cores run at different IPC and
frequency. **Not confirmed** whether a 20% hard cap on a 8P+16E machine means
20% of an idealised uniform machine, 20% of summed scheduler quanta, or
something frequency-weighted. Treat CPU caps on hybrid hardware as approximate
and verify empirically on the target machine before promising a number to the
user. (Related and separate: `SetProcessInformation` with `ProcessPowerThrottling` and
a `PROCESS_POWER_THROTTLING_STATE` is a documented per-process throttling knob,
not a per-job one.
<https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-setprocessinformation>
Its exact effect on core selection on hybrid hardware is **not confirmed**
here.)

**Failure mode to handle:** "If Dynamic Fair Share Scheduling (DFSS) is enabled,
the CPU rate cannot be set and SetInformationJobObject will fail with error code
50 ('The request is not supported')."
<https://github.com/MicrosoftDocs/sdk-api/blob/docs/sdk-api-src/content/jobapi2/nf-jobapi2-setinformationjobobject.md>
DFSS is on by default in Remote Desktop Services sessions, so a broker running
inside an RDS session must degrade gracefully instead of failing session
creation. Also stated in the struct page: "CPU rate control cannot be used by
job objects in applications running under Remote Desktop Services... if Dynamic
Fair Share Scheduling (DFSS) is in effect."

Information-class numeric values used with `IS`/`IQ` (from the sdk-api source):
`JobObjectBasicLimitInformation` = 2, `JobObjectBasicProcessIdList` = 3,
`JobObjectEndOfJobTimeInformation` = 6,
`JobObjectCpuRateControlInformation` = 15,
`JobObjectLimitViolationInformation2` = 34.
<https://github.com/MicrosoftDocs/sdk-api/blob/docs/sdk-api-src/content/jobapi2/nf-jobapi2-setinformationjobobject.md>
<https://github.com/MicrosoftDocs/sdk-api/blob/docs/sdk-api-src/content/jobapi2/nf-jobapi2-queryinformationjobobject.md>
Values for the other classes used below (`JobObjectBasicAccountingInformation`,
`JobObjectBasicAndIoAccountingInformation`,
`JobObjectExtendedLimitInformation`,
`JobObjectAssociateCompletionPortInformation`) are listed on those same pages;
read the exact numbers off the page or the SDK header at implementation time
rather than hard-coding from memory.

`JobObjectLimitViolationInformation2` availability: "Windows 8.1, Windows Server
2012 R2, Windows 8, Windows Server 2012, Windows 7 ... : This flag is not
supported", i.e. Windows 10 and later only.
<https://github.com/MicrosoftDocs/sdk-api/blob/docs/sdk-api-src/content/jobapi2/nf-jobapi2-queryinformationjobobject.md>

---

## 2. Job accounting: what is live and what is peak

| Class | Struct | Gives |
|---|---|---|
| `JobObjectBasicAccountingInformation` | `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION` | `TotalUserTime`, `TotalKernelTime` (100 ns ticks, cumulative including exited processes), `ThisPeriodTotalUserTime`/`ThisPeriodTotalKernelTime`, `TotalPageFaultCount`, `TotalProcesses`, **`ActiveProcesses` (live count)**, `TotalTerminatedProcesses`. <https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information> |
| `JobObjectBasicAndIoAccountingInformation` | `JOBOBJECT_BASIC_AND_IO_ACCOUNTING_INFORMATION` | the above plus an `IO_COUNTERS` covering "all processes that have ever been associated with the job, in addition to ... all processes currently associated". <https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_and_io_accounting_information> |
| `JobObjectBasicProcessIdList` | `JOBOBJECT_BASIC_PROCESS_ID_LIST` | `NumberOfAssignedProcesses`, `NumberOfProcessIdsInList`, `ProcessIdList[1]` (variable length `ULONG_PTR` array). <https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_process_id_list> ; field types per <https://github.com/mingw-w64/mingw-w64/blob/master/mingw-w64-headers/include/winnt.h> |
| `JobObjectExtendedLimitInformation` (queried) | `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` | `PeakProcessMemoryUsed`, `PeakJobMemoryUsed`, **peaks, not current**: "The peak memory used by any process ever associated with the job" / "The peak memory usage of all processes currently associated with the job", tracked constantly. <https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information> |
| `JobObjectLimitViolationInformation2` | `JOBOBJECT_LIMIT_VIOLATION_INFORMATION_2` | `LimitFlags`, `ViolationLimitFlags`, `IoReadBytes(+Limit)`, `IoWriteBytes(+Limit)`, `PerJobUserTime(+Limit)`, **`JobMemory`**, `JobHighMemoryLimit`/`JobMemoryLimit`, CPU/IO/Net rate tolerances. <https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_limit_violation_information_2> |

**Answer to "which gives a live memory gauge":** none of the job classes gives an
unconditional current committed-memory reading. `PeakJobMemoryUsed` is a
high-water mark. The only documented *current* number is
`JOBOBJECT_LIMIT_VIOLATION_INFORMATION_2.JobMemory`, and it is defined only in a
violation context: "If the `ViolationLimitFlags` member specifies
`JOB_OBJECT_LIMIT_JOB_MEMORY_HIGH` or `JOB_OBJECT_LIMIT_JOB_MEMORY_LOW`, this
member contains the committed memory for all processes in the job at the time
the notification was sent."
<https://github.com/MicrosoftDocs/sdk-api/blob/docs/sdk-api-src/content/winnt/ns-winnt-jobobject_limit_violation_information_2.md>

The documented trick to get a usable gauge is therefore to set a *notification*
limit pair with `JobObjectNotificationLimitInformation2`
(`JOBOBJECT_NOTIFICATION_LIMIT_INFORMATION_2` carries both
`JobHighMemoryLimit` and `JobLowMemoryLimit`), which produces
`JOB_OBJECT_MSG_NOTIFICATION_LIMIT` on the completion port, then read
`JobMemory` from `JobObjectLimitViolationInformation2`. This is a threshold
crossing detector, not a continuous gauge.
<https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_notification_limit_information_2>
For a continuous per-session memory number, iterate the job's PIDs from
`JobObjectBasicProcessIdList` and call `GetProcessMemoryInfo`
(`PROCESS_MEMORY_COUNTERS_EX`: `WorkingSetSize` is "The current working set
size, in bytes", the RSS analogue, and `PagefileUsage` is "The Commit Charge
value in bytes for this process", with the note that on Windows 7 / Server
2008 R2 and earlier `PagefileUsage` is always zero and `PrivateUsage` should be
read instead).
<https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-getprocessmemoryinfo>
<https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex>

**Derived** x64 layouts:

- `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION`: 48 bytes. TotalUserTime 0,
  TotalKernelTime 8, ThisPeriodTotalUserTime 16, ThisPeriodTotalKernelTime 24,
  TotalPageFaultCount 32, TotalProcesses 36, ActiveProcesses 40,
  TotalTerminatedProcesses 44.
- `JOBOBJECT_BASIC_AND_IO_ACCOUNTING_INFORMATION`: 96 bytes; BasicInfo 0,
  IoInfo 48.
- `JOBOBJECT_BASIC_PROCESS_ID_LIST`: header 8 bytes, array of `ULONG_PTR`
  starting at offset 8 (struct as declared is 16 bytes because of the
  `ProcessIdList[1]` tail). Allocate
  `8 + n*8` and grow on `ERROR_MORE_DATA`.
- `JOBOBJECT_LIMIT_VIOLATION_INFORMATION_2`: 104 bytes. LimitFlags 0,
  ViolationLimitFlags 4, IoReadBytes 8, IoReadBytesLimit 16, IoWriteBytes 24,
  IoWriteBytesLimit 32, PerJobUserTime 40, PerJobUserTimeLimit 48, JobMemory 56,
  JobHighMemoryLimit/JobMemoryLimit 64, (Cpu)RateControlTolerance 72,
  (Cpu)RateControlToleranceLimit 76, JobLowMemoryLimit 80,
  IoRateControlTolerance 88, IoRateControlToleranceLimit 92,
  NetRateControlTolerance 96, NetRateControlToleranceLimit 100. Field order and
  types from <https://github.com/mingw-w64/mingw-w64/blob/master/mingw-w64-headers/include/winnt.h>;
  tolerance fields are 4-byte enums (`JOBOBJECT_RATE_CONTROL_TOLERANCE`).
- `JOBOBJECT_ASSOCIATE_COMPLETION_PORT`: 16 bytes; `CompletionKey` (PVOID) 0,
  `CompletionPort` (HANDLE) 8.

### Completion port messages

`SetInformationJobObject(job, JobObjectAssociateCompletionPortInformation, ...)`
with `JOBOBJECT_ASSOCIATE_COMPLETION_PORT { CompletionKey, CompletionPort }`.
One completion port per job; on Windows 8+ pass `NULL` for `CompletionPort` to
remove the association. Messages arrive via `GetQueuedCompletionStatus` where
`lpNumberOfBytes` is the **message id**, `lpOverlapped` is the message-specific
value (usually a PID), and `lpCompletionKey` is your key.
<https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_associate_completion_port>

Message ids (header values):
`JOB_OBJECT_MSG_END_OF_JOB_TIME` 1, `..._END_OF_PROCESS_TIME` 2,
`..._ACTIVE_PROCESS_LIMIT` 3, `..._ACTIVE_PROCESS_ZERO` 4, `..._NEW_PROCESS` 6,
`..._EXIT_PROCESS` 7, `..._ABNORMAL_EXIT_PROCESS` 8,
`..._PROCESS_MEMORY_LIMIT` 9, `..._JOB_MEMORY_LIMIT` 10,
`..._NOTIFICATION_LIMIT` 11, `..._JOB_CYCLE_TIME_LIMIT` 12,
`..._SILO_TERMINATED` 13.
<https://github.com/mingw-w64/mingw-w64/blob/master/mingw-w64-headers/include/winnt.h>
Descriptions per message (including which ones carry a PID in `lpOverlapped`):
<https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_associate_completion_port>

Two documented caveats that matter for a broker that reports session state:

1. Delivery is best effort except for notification limits: "except for limits
   set with the `JobObjectNotificationLimitInformation` information class,
   messages are intended only as notifications and their delivery to the
   completion port is not guaranteed... Notifications for limits set with
   `JobObjectNotificationLimitInformation` are guaranteed to arrive."
2. Associating the port on a live job races: "if processes are actively
   starting and exiting within a job, and you are in the process of assigning a
   completion port to the job, you may miss messages... it is best to associate
   a completion port with a job when the job is inactive."

Same page. So: create the job, attach the IOCP, *then* spawn Chrome, and treat
`ACTIVE_PROCESS_ZERO` as advisory, backed by a periodic
`JobObjectBasicAccountingInformation.ActiveProcesses` poll.

---

## 3. Named pipes under node:net / libuv, and Bun's state

### Default pipe DACL: yes, Everyone + Anonymous get read

`CreateNamedPipe` with `lpSecurityAttributes == NULL`: "the named pipe gets a
default security descriptor and the handle cannot be inherited. The ACLs in the
default security descriptor for a named pipe grant full control to the
LocalSystem account, administrators, and the creator owner. They also grant read
access to members of the Everyone group and the anonymous account."
<https://github.com/MicrosoftDocs/sdk-api/blob/docs/sdk-api-src/content/winbase/nf-winbase-createnamedpipea.md>
(rendered <https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createnamedpipea>)

libuv passes exactly that (no `SECURITY_ATTRIBUTES`):

```c
req->pipeHandle =
    CreateNamedPipeW(handle->name,
                     PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | WRITE_DAC |
                       (firstInstance ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0),
                     PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                     PIPE_UNLIMITED_INSTANCES, 65536, 65536, 0, NULL);
```

<https://github.com/libuv/libuv/blob/v1.x/src/win/pipe.c> (`pipe_alloc_accept`).
Confirmed independently by a Node core maintainer on the issue tracker: "Node
(well, libuv) calls CreateNamedPipe() with the WRITE_DAC (but not WRITE_OWNER)
flag and default security attributes, meaning: [default SD quote]... as node has
worked this way since basically forever any change in default behavior risks
breaking existing libraries or applications, so we're unlikely to make that
change." Comment by bnoordhuis, 2023-03-14, on <https://github.com/nodejs/node/issues/47086>.
That issue was closed as wontfix (closed 2023-03-21).

So the honest security statement for the Windows port: **a default
`server.listen('\\\\.\\pipe\\...')` pipe is readable by every local account and
by the anonymous logon.** Read access is enough to open the pipe handle, which
for a JSON command protocol is enough to eavesdrop, so this must not be the
shipped default.

### Can a Node/Bun process tighten the DACL without native code?

Partly, and only by removing access, not by writing an arbitrary DACL.

- libuv exposes `uv_pipe_chmod(handle, mode)`, which builds an `EXPLICIT_ACCESS`
  for the **Everyone** SID and calls `SetSecurityInfo` with
  `DACL_SECURITY_INFORMATION` on the pipe handle. That is why libuv asks for
  `WRITE_DAC` at creation time.
  <https://github.com/libuv/libuv/blob/v1.x/src/win/pipe.c> (`uv_pipe_chmod`)
- Node surfaces it as `server.listen({ path, readableAll, writableAll })`:
  "`readableAll` {boolean} For IPC servers makes the pipe readable for all
  users. **Default:** `false`" and the same for `writableAll`.
  <https://github.com/nodejs/node/blob/main/doc/api/net.md> (`server.listen(options)`)
  Both default to false, but Node only calls the chmod path when one of them is
  *true*: with both false/undefined the pipe keeps the default SD, which is the
  "Everyone: read" one. This gap is described in later comments on the same
  issue thread (SlugFiller, 2026-01-22; fjch1997 and Pricer187, 2026-06-08),
  with the workarounds `server._handle.fchmod(0)` (internal API) or
  `fs.chmod(PIPE_PATH, 0)` after listen.
  <https://github.com/nodejs/node/issues/47086>
  Both workarounds are user-reported, not documented; treat them as **not
  confirmed**, especially under Bun.
- There is no documented Node or Bun API to supply a `SECURITY_ATTRIBUTES` or a
  full SDDL string to the pipe. A custom DACL (for example: only the current
  user SID, no Everyone, no ANONYMOUS LOGON) requires calling `CreateNamedPipeW`
  yourself, i.e. native code (`koffi`/`ffi-napi`/a small addon) or an out-of-line
  helper `.exe`. **No primary source contradicts this**; the absence is the
  finding. The closest documented Node-level mitigation is the chmod-style
  removal of Everyone access described above, which does not remove
  ANONYMOUS LOGON.

### `FILE_FLAG_FIRST_PIPE_INSTANCE`

"If you attempt to create multiple instances of a pipe with this flag, creation
of the first instance succeeds, but creation of the next instance fails with
`ERROR_ACCESS_DENIED`." Value 0x00080000.
<https://github.com/MicrosoftDocs/sdk-api/blob/docs/sdk-api-src/content/winbase/nf-winbase-createnamedpipea.md>
libuv relies on this for "address in use" detection: it creates the first accept
instance with the flag and maps `ERROR_ACCESS_DENIED` to `UV_EADDRINUSE`
("Attempt to create the first pipe with FILE_FLAG_FIRST_PIPE_INSTANCE. If this
fails then there's already a pipe server for the given pipe name.")
<https://github.com/libuv/libuv/blob/v1.x/src/win/pipe.c>
This is the Windows equivalent of the broker's "is another instance already
bound to the socket" check, and it is a real squatting defence: a hostile
process that grabs the name first makes the broker fail loudly rather than
silently sharing the endpoint.

Also relevant: pipes do not persist. "Pipes will *not persist*. They are removed
when the last reference to them is closed."
<https://github.com/nodejs/node/blob/main/doc/api/net.md>
No stale-socket cleanup logic is needed, unlike the Linux `.sock` file.

### Bun issue 15350 and Bun's AF_UNIX support on Windows

- Issue: "Named pipes don't work for HTTP servers", filed 2024-11-22 against Bun
  1.1.36 on Windows 10.0.22631. `node:net` `createServer().listen('\\\\.\\pipe\\test')`
  works; `node:http` `.listen(pipe)` and `Bun.serve({ unix: '\\\\.\\pipe\\test' })`
  both fail with `ENOENT ... syscall: "listen"`.
  <https://github.com/oven-sh/bun/issues/15350>
- Maintainer reply (cirospaciari, same day): "AF_UNIX is currently support by
  Bun.serve but not named pipes yet. Named Pipes is missing support on
  `node:http` and currently supported on `node:tls`, `node:net` and `node:http2`."
  <https://github.com/oven-sh/bun/issues/15350#issuecomment-2494175003>
- **The issue is still open** as of this research (state `open`, last activity a
  2026-09-04 "will this be solved" ping, no maintainer resolution).
  <https://github.com/oven-sh/bun/issues/15350>
- Does Bun support AF_UNIX on a *filesystem path* on Windows? The uSockets
  backend does compile the AF_UNIX path on Windows: `packages/bun-usockets/src/bsd.c`
  includes `<afunix.h>` under `_WIN32`, builds a `sockaddr_un` with
  `sun_family = AF_UNIX`, and `internal_bsd_create_listen_socket_unix` calls
  `bsd_create_socket(AF_UNIX, SOCK_STREAM, 0, NULL)` followed by bind/listen,
  with Windows-specific error translation (`WSAENETDOWN` → simulated `ENOENT`).
  <https://github.com/oven-sh/bun/blob/main/packages/bun-usockets/src/bsd.c>
  Bun's own docs document `Bun.serve({ unix: "/tmp/my-socket.sock" })` and note
  that abstract-namespace sockets are Linux only.
  <https://bun.com/docs/api/http> ("Unix domain sockets", "Abstract namespace sockets")
  There is a merged Bun PR specifically about Windows unix socket paths,
  "server: fix Server.url for Windows Unix socket paths"
  (<https://github.com/oven-sh/bun/pull/40307>), which is further evidence the
  path is exercised on Windows. What is **not confirmed** from a primary source
  is an explicit statement that `Bun.serve({ unix })` with a *Windows filesystem
  path* is supported and tested end to end; the code path exists, the docs do not
  call out Windows, and issue 15350 shows the pipe-name form failing. **Verify on
  a real Windows box before designing around it.**

Practical conclusion for the broker transport: on Windows use `node:net`
(`net.createServer().listen('\\\\.\\pipe\\sbar-orbit-<user>-<random>')`), which
both Node and Bun support today, and carry the framing protocol over it, rather
than `Bun.serve`. If HTTP semantics are required, run the HTTP parser on top of
the `node:net` stream.

---

## 4. AF_UNIX on Windows: no peer credentials

Microsoft's announcement enumerates what was left out, and credentials are on
that list: "Ancillary data: Linux's unix socket implementation supports passing
ancillary data such as passing file descriptors (`SCM_RIGHTS`) or credentials
(`SCM_CREDENTIALS`) over the socket. There is no support for ancillary data in
the Windows unix socket implementation." Also unsupported: `SOCK_DGRAM` /
`SOCK_SEQPACKET`, autobind, `socketpair`.
<https://devblogs.microsoft.com/commandline/af_unix-comes-to-windows/>

There is no `SO_PEERCRED` in the documented Winsock `SOL_SOCKET` option table.
<https://learn.microsoft.com/en-us/windows/win32/api/winsock/nf-winsock-getsockopt>
(and the socket options reference,
<https://learn.microsoft.com/en-us/windows/win32/winsock/socket-options>).
**Not confirmed** that any AF_UNIX peer-credential mechanism exists on Windows;
everything found says the opposite.

What Microsoft does say is the security model for AF_UNIX on Windows: "Unix
sockets provide a mechanism for secure communication. Communication over unix
sockets can be secured by controlling the file (or directory) permissions on the
pathname sockets (or the parent directory)... The same level of security is
available and enforced on the Windows unix socket implementation."
<https://devblogs.microsoft.com/commandline/af_unix-comes-to-windows/>
So the AF_UNIX answer on Windows is filesystem ACLs on the socket path, and the
socket file is "a custom NTFS reparse point" (same post), which also means it
must be deleted with `DeleteFile` before rebinding.

**Accepted alternatives for authenticating a local client, in descending order
of strength:**

1. **Named pipe + peer identity from the pipe itself.** This is the one
   mechanism with true kernel-provided peer identity on Windows:
   - `GetNamedPipeClientProcessId(hPipe, &pid)` "Retrieves the client process
     identifier for the specified named pipe"; the handle "must be created by
     the CreateNamedPipe function".
     <https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeclientprocessid>
   - `ImpersonateNamedPipeClient(hPipe)` makes the server thread carry "the
     security context of the last message read from the pipe", after which
     `OpenThreadToken` + `GetTokenInformation(TokenUser)` yields the client's
     SID; `RevertToSelf` when done. The doc carries an explicit warning that a
     failed call leaves you running as *yourself*, so the return value must be
     checked.
     <https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-impersonatenamedpipeclient>
   Both require native calls; neither is exposed by Node or Bun. Node/Bun give
   you no handle-level access to the accepted pipe instance through public API.
2. **Restrictive DACL on the endpoint** (pipe DACL limited to the current user
   SID, or an AF_UNIX socket path under a directory ACL'd to the user). Same
   caveat: full DACL control needs native code; `readableAll/writableAll=false`
   plus an explicit chmod-style removal is the pure-JS approximation.
3. **Bearer token in an ACL'd file under `%LOCALAPPDATA%`**, presented by the
   client on connect. This is the pragmatic pure-JS answer and is the pattern
   Chrome itself effectively uses for `DevToolsActivePort` (secret path
   component in the browser GUID, file inside the user-data dir). Microsoft
   documents `%LOCALAPPDATA%` (`FOLDERID_LocalAppData`) as per-user, non-roaming
   storage <https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid>,
   and the default ACL on a user's profile subtree grants the user and
   Administrators/SYSTEM. **Not confirmed** from a single Microsoft page that the
   default `%LOCALAPPDATA%` DACL excludes other standard users on every SKU;
   write the token file with an explicit DACL (or at minimum verify it after
   creation) rather than trusting inheritance. Token must be compared in
   constant time and rotated per broker start.

Recommended shape for the port: named pipe, `FILE_FLAG_FIRST_PIPE_INSTANCE`
squat protection via libuv, unguessable pipe name including a per-start random
component, plus a token file under `%LOCALAPPDATA%\SbarOrbit\` with an explicit
DACL, with an optional native add-on upgrade path to
`ImpersonateNamedPipeClient` for real SID checks.

---

## 5. Chrome on Windows headless

- `--headless` is defined in `//ui/gfx/switches.cc` as
  `const char kHeadless[] = "headless";` with the comment "Run in headless mode,
  i.e., without a UI or display server dependencies."
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/gfx/switches.cc>
  and Chrome's own headless mode is gated on that switch in
  `chrome/app/chrome_main.cc` (`if (headless::IsHeadlessMode()) { ...
  headless::InitHeadlessMode() ... }`).
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/app/chrome_main.cc>
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/headless/headless_mode_util.cc>
  New headless is available "on Linux, Windows and Mac platforms" per the comment
  in that last file.
- **`--headless=new` is obsolete as a distinguishing flag.** Chrome's
  documentation now says plain `--headless` *is* the new mode: "Chrome now has
  unified Headless and headful modes. Since Chrome 132.0.6793.0 the old Headless
  mode is only available as a standalone binary named `chrome-headless-shell`".
  <https://developer.chrome.com/docs/chromium/new-headless>
  The old shell still forces `--headless=old` for itself
  (`command_line->AppendSwitchASCII(::switches::kHeadless, "old")` in
  `headless_content_main_delegate.cc`).
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/headless/lib/headless_content_main_delegate.cc>
  Practical guidance for Chrome 13x-15x: pass `--headless` (no value). `=new` is
  still accepted as a value at the time of writing but is redundant; **not
  confirmed** whether `=new` is scheduled for removal.
- `--user-data-dir` selects the profile root. Chromium documents the
  `user-data-dir` switch in `content_switches.cc` (referenced as "as defined by
  the content embedder").
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/public/common/content_switches.cc>
  Windows default location and the switch's semantics:
  <https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md>
- `--remote-debugging-port=0` plus the `DevToolsActivePort` file is the correct
  port-discovery mechanism, and this is unchanged on Windows.
  `devtools_http_handler.cc` writes the file into the output directory:
  ```
  base::FilePath path = output_directory.Append(kDevToolsActivePortFileName);
  std::string port_target_string =
      base::StringPrintf("%d\n%s", ip_address->port(), browser_guid.c_str());
  ```
  with the comment "Write this port to a well-known file in the profile
  directory so Telemetry, ChromeDriver, etc. can pick it up."
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/devtools_http_handler.cc>
  The filename constant is `DevToolsActivePort`:
  `const base::FilePath::CharType kDevToolsActivePortFileName[] = FILE_PATH_LITERAL("DevToolsActivePort");`
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/public/common/content_constants.cc>
  Chrome reads it back from the user-data dir in
  `RemoteDebuggingServer::GetPortFromUserDataDir`, confirming the file lives in
  the **user data dir root** (not the profile subdirectory): first line is the
  port, second line is the `/devtools/browser/<guid>` path.
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/devtools/remote_debugging_server.cc>
  With port 0 Chrome binds `127.0.0.1` first and falls back to `::1`
  (`TCPServerSocketFactory::CreateLocalHostServerSocket`), same file.
- **Blocking gotcha, Google Chrome branded builds only:** remote debugging is
  refused when the user-data dir is the *default* one.
  `IsRemoteDebuggingAllowed` returns
  `NotStartedReason::kDisabledByDefaultUserDataDir` when
  `is_default_user_data_dir` on Windows/macOS/Linux under
  `BUILDFLAG(GOOGLE_CHROME_BRANDING)`.
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/devtools/remote_debugging_server.cc>
  The broker already passes a private `--user-data-dir`, so this is satisfied,
  but it means "attach to the user's existing Chrome" is not an option, which
  matches the project's isolation goal anyway. It also interacts with §6 below.
- Locating the browser: `App Paths`. Windows documents
  `HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths` (or
  the `HKEY_CURRENT_USER` equivalent for per-user installs); the subkey name
  matches the executable file name, the `(Default)` value "is the fully
  qualified path to the application" (`REG_SZ`), and the `Path` value is
  prepended to the process `PATH`.
  <https://learn.microsoft.com/en-us/windows/win32/shell/app-registration>
  Chrome's installer writes exactly that: `GetChromeAppRegistrationEntries`
  builds `kAppPathsRegistryKey + "\\" + chrome_exe.BaseName()` with the exe path
  as the default value and the directory as `kAppPathsRegistryPathName`.
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/installer/util/shell_util.cc>
  So probe, in order: `HKCU\...\App Paths\chrome.exe`,
  `HKLM\...\App Paths\chrome.exe` (both `KEY_WOW64_32KEY` and `KEY_WOW64_64KEY`
  views), then the same for `msedge.exe`, then the conventional
  `%ProgramFiles%\Google\Chrome\Application\chrome.exe` fallbacks.
  **Not confirmed** from a Microsoft/Chromium page that `msedge.exe` is
  registered under App Paths, though it follows the same convention; verify on a
  target machine.
- Version: `GetFileVersionInfoSizeW` then `GetFileVersionInfoW(path, 0, len,
  buf)` then `VerQueryValueW(buf, L"\\", ...)` for the `VS_FIXEDFILEINFO`.
  `GetFileVersionInfoW` requires `winver.h`, `Version.lib`, and explicitly says
  "Call the GetFileVersionInfoSize function before calling the
  GetFileVersionInfo function."
  <https://learn.microsoft.com/en-us/windows/win32/api/winver/nf-winver-getfileversioninfow>
  <https://learn.microsoft.com/en-us/windows/win32/api/winver/nf-winver-verqueryvaluew>
  From Node/Bun without native code, the zero-dependency alternative is running
  `chrome.exe --version` and parsing, or reading the version from the
  installation directory name; both are weaker but need no FFI.

---

## 6. App Bound Encryption and the private user-data dir

- `SupportLevel` enumeration in Chromium includes `kNotUsingDefaultUserDataDir = 4`:
  ```
  enum class SupportLevel { kSupported = 0, kNotSystemLevel = 1, kNotLocalDisk = 2,
    kApiFailed = 3, kNotUsingDefaultUserDataDir = 4, kUserDataDirNotLocalDisk = 5,
    kDisabledByPolicy = 6, kDisabledByRoamingWindowsProfile = 7,
    kDisabledByRoamingChromeProfile = 8, ... };
  ```
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/os_crypt/app_bound_encryption_win.h>
- `GetAppBoundEncryptionSupportLevel(PrefService*)` returns it exactly as the
  question assumed:
  ```
  const auto maybe_using_default_user_data_dir = chrome::IsUsingDefaultDataDirectory();
  if (!maybe_using_default_user_data_dir.has_value()) return SupportLevel::kApiFailed;
  // User data dir can be overridden by policy or by a command line option.
  if (!maybe_using_default_user_data_dir.value())
      return SupportLevel::kNotUsingDefaultUserDataDir;
  ```
  and before that, `if (!install_static::IsSystemInstall()) return
  SupportLevel::kNotSystemLevel;`.
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/os_crypt/app_bound_encryption_win.cc>
  The header comments that everything other than `kSupported` means "decrypt
  operations may succeed, but encrypt operations should not be carried out",
  except `kNotSystemLevel` where "no cryptographic operations are available".
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/os_crypt/app_bound_encryption_win.h>

  **Direct consequence for Orbit:** because the broker always launches Chrome
  with a private `--user-data-dir`, ABE is *never* active in an Orbit session.
  Data written in an Orbit profile falls back to the DPAPI (`v10`) path. That is
  the right outcome (it keeps Orbit out of the elevation service entirely), but
  it must be stated in the security docs: an Orbit profile's cookies are
  protected only by DPAPI-under-the-user, i.e. by the same user account, not by
  app identity. It also means Orbit can never read the user's real Chrome
  cookies, which is the desired isolation property.

- **v10 / v20 prefix split**, confirmed in source:
  - `constexpr char kKeyTag[] = "v10";` with the comment "Data prefix for data
    encrypted with DPAPI. This must match kEncryptionVersionPrefix in
    os_crypt_win.cc", and `constexpr uint8_t kDPAPIKeyPrefix[] = {'D','P','A','P','I'};`
    <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/os_crypt/async/browser/dpapi_key_provider.cc>
  - `inline constexpr char kAppBoundDataPrefix[] = "v20";` ("Tag for data
    encrypted with app-bound encryption key. This is used by OSCryptAsync to
    identify that data has been encrypted with this key.") and
    `inline constexpr uint8_t kCryptAppBoundKeyPrefix[] = {'A','P','P','B'};`
    ("Key prefix for a key encrypted with app-bound Encryption.")
    <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/os_crypt/app_bound_encryption_provider_win.h>
  So: cookie blobs starting `v10` are DPAPI-wrapped, `v20` are App-Bound; the
  `encrypted_key` in `Local State` is base64 with a `DPAPI` or `APPB` magic.
- **Elevation service:** ABE "relies on a privileged service to verify the
  identity of the requesting application... Because the App-Bound service is
  running with system privileges, attackers need to do more than just coax a user
  into running a malicious app. Now, the malware has to gain system privileges,
  or inject code into Chrome". Shipped with cookies in Chrome 127. Policy switch:
  `ApplicationBoundEncryptionEnabled`. Failed verification emits Windows event id
  257, source "Chrome", Application log.
  <https://security.googleblog.com/2024/07/improving-security-of-chrome-cookies-on.html>
  The Chromium side is `chrome/elevation_service` (`elevation_service_idl.h`,
  `elevator.h`), called via COM on a COM-enabled thread with
  `EncryptAppBoundString` / `DecryptAppBoundString`.
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/os_crypt/app_bound_encryption_win.h>
- Additional disabling conditions worth knowing (same `.cc`): roaming Windows
  profile (`GetProfileType() > 0`), an `HKLM\SOFTWARE\FSLogix` key,
  `user_data_dir.IsNetwork()`, and the managed
  `prefs::kApplicationBoundEncryptionEnabled` pref. A broker that puts profiles
  on a network path would therefore also lose ABE, but since the private dir
  already disables it, put profiles on a local disk for performance reasons, not
  crypto ones.

---

## 7. Per-process / per-job network confinement without a kernel driver

Short answer: **there is no documented way to scope a Windows Firewall rule or a
WFP filter to a Job Object or to a PID from user mode.** Be honest about this in
the product docs: Windows cannot reproduce the Linux network-namespace or
per-cgroup filtering story without a driver or a virtualised container.

What exists:

- **Windows Firewall rules are program-scoped, not process-scoped.**
  `New-NetFirewallRule -Program <path>` matches an executable image path.
  <https://learn.microsoft.com/en-us/powershell/module/netsecurity/new-netfirewallrule>
  Other scoping parameters are `-Service` ("the short name of a ... service to
  which the firewall rule applies"), `-Package` ("Specifies the Windows Store
  application to which the firewall rule applies. This parameter is specified as
  a security identifier (SID)"), `-LocalUser` / `-RemoteUser` (SDDL), and address
  or port conditions. There is **no** `-Job`, `-ProcessId` or `-Pid` parameter in
  the documented syntax block. Same page.
  So blocking "this Chrome" but not "the user's Chrome" is impossible via
  `-Program`: both are the same `chrome.exe` path.
- **WFP filter conditions** confirm the same shape at the API level. The
  documented ALE conditions are image-path and identity based:
  `FWPM_CONDITION_ALE_APP_ID` ("The lower-case fully qualified device path of
  the application, as returned by the FwpmGetAppIdFromFileName0 function"),
  `FWPM_CONDITION_ALE_ORIGINAL_APP_ID`, `FWPM_CONDITION_ALE_USER_ID`,
  `FWPM_CONDITION_ALE_PACKAGE_ID` ("The security identifier (SID) of an app
  container"), plus `FWPM_CONDITION_COMPARTMENT_ID` ("The ID of the TCPIP
  compartment").
  <https://learn.microsoft.com/en-us/windows/win32/fwp/filtering-condition-identifiers->
  No process-id and no job-object condition appears in that list. Adding filters
  at ALE layers (`FWPM_LAYER_ALE_AUTH_CONNECT_V4` etc.) is a user-mode
  `FwpmFilterAdd0` operation and does not itself require a driver
  (<https://learn.microsoft.com/en-us/windows/win32/fwp/management-filtering-layer-identifiers->),
  but it needs administrator rights and still cannot see a PID. Only a callout
  driver can make per-flow decisions with richer context.
- **AppContainer / package SID scoping is the one real per-instance sandbox
  boundary reachable from user mode**, because
  `FWPM_CONDITION_ALE_PACKAGE_ID` and `New-NetFirewallRule -Package` both accept
  an AppContainer SID, and an AppContainer SID can be created per profile with
  `CreateAppContainerProfile` and applied at spawn time with
  `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`.
  <https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createappcontainerprofile>
  <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute>
  This is how Chromium's own sandbox isolates renderers. But: it requires
  `CreateProcessW` with extended startup info (native code), and running the
  *browser process* inside an AppContainer is not a configuration Chrome
  supports. **Not confirmed** that a headless Chrome browser process launches
  and functions correctly inside an AppContainer; treat as research, not plan.
- **Network compartments are not a user-mode API.** The documented
  `COMPARTMENT_ID` enumeration has only `UNSPECIFIED_COMPARTMENT_ID = 0` and
  `DEFAULT_COMPARTMENT_ID`.
  <https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-compartment_id>
  `SetCurrentThreadCompartmentId` is documented verbatim as "**Reserved for
  future use. Do not use this function.**" with `CompartmentId` marked
  "Reserved".
  <https://learn.microsoft.com/en-us/windows/win32/api/netioapi/nf-netioapi-setcurrentthreadcompartmentid>
  `Get-NetCompartment` exists but only enumerates compartments; the NetTCPIP
  module ships no `New-NetCompartment`.
  <https://learn.microsoft.com/en-us/powershell/module/nettcpip/get-netcompartment>
  Compartments are created by the container stack (HNS/HCN) for Windows
  containers, not by ordinary applications.
  <https://learn.microsoft.com/en-us/virtualization/windowscontainers/container-networking/network-isolation-security>
  **Conclusion: not usable.**
- **Job objects do have one network knob, and it is bandwidth only, not policy.**
  `JobObjectNetRateControlInformation` /
  `JOBOBJECT_NET_RATE_CONTROL_INFORMATION { MaxBandwidth, ControlFlags, DscpTag }`
  caps *outgoing* bandwidth for the job and sets a DSCP tag, Windows 10 / Server
  2016 and later. It cannot allow or deny destinations.
  <https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_net_rate_control_information>
  Useful for a "don't saturate the user's uplink" guarantee; useless for
  egress filtering.

**Honest recommendation:** on Windows, ship network confinement at the
*application* layer rather than the kernel layer, i.e. drive Chrome's own
policy (`--host-resolver-rules`, a per-session proxy the broker controls,
`--proxy-server=` pointing at a broker-owned allowlisting proxy on 127.0.0.1)
and document that a determined process inside the session can still reach the
network directly. A true per-session egress boundary on Windows requires either
a WFP callout driver, a Windows container / Hyper-V isolation, or running the
session inside a VM. `JobObjectNetRateControlInformation` can be layered on for
bandwidth.

---

## 8. Ensuring the child tree dies with the broker (besides Job Objects)

Job objects with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` remain the right primary
mechanism: closing the last handle, including implicitly when the broker process
dies and the kernel closes its handles, terminates every associated process.
<https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-createjobobjectw>
Do not set any breakaway flag, or the guarantee has holes
(<https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects>).

Supplementary and fallback mechanisms, all documented:

1. **`TerminateProcess` on each PID from `JobObjectBasicProcessIdList`**, as an
   explicit shutdown path that does not depend on handle-close timing.
   <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess>
   <https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_process_id_list>
2. **`taskkill /PID <pid> /T /F`**, which walks the child tree: "/t Ends the
   specified process and any child processes started by it", "/f Specifies that
   processes be forcefully ended".
   <https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill>
   Shell-outable from Bun without native code; this is the pragmatic pure-JS
   fallback when no job object could be created.
3. **A watchdog handle the child waits on.** Give Chrome (or a small shim) an
   inheritable handle to a process/event and have it exit when signalled. The
   documented primitive is handle inheritance
   (`bInheritHandles` / `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`
   <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute>)
   plus `WaitForSingleObject` on the broker's process handle, which becomes
   signalled on broker exit
   (<https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject>).
   Chrome itself does not accept such a handle, so this needs a shim launcher;
   **not confirmed** that any Chrome switch provides this.
4. **`WaitForSingleObject` on the job handle**: "The state of a job object is set
   to signaled when all of its processes are terminated because the specified
   end-of-job time limit has been exceeded."
   <https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects>
   Note the narrow condition, this is *not* a general "job is empty" signal; use
   `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO` on the completion port for that (§2).
5. **`.NET Process.Kill(entireProcessTree: true)`** exists if a .NET helper is
   ever in the picture, with the documented caveat that "`WaitForExit` and
   `HasExited` will indicate that exiting has completed after the given process
   exits, even if all descendants have not yet exited."
   <https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.kill>
6. **`JOB_OBJECT_LIMIT_ACTIVE_PROCESS`** as a blast-radius limit rather than a
   cleanup mechanism: a job that cannot exceed N processes bounds a runaway
   renderer fork loop.
   <https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information>

There is no Windows analogue of `prctl(PR_SET_PDEATHSIG)` in the documented
Win32 API; the job object is the sanctioned replacement. **Not confirmed** that
any per-process "die when parent dies" flag exists.

---

## Summary of design impact

1. Job object per session, unnamed, `KILL_ON_JOB_CLOSE`, no breakaway,
   `ACTIVE_PROCESS` cap, `JOB_MEMORY` sized for *commit* not RSS, CPU via
   `MIN_MAX_RATE` (graceful degrade on error 50 under DFSS). IOCP attached
   before the first spawn.
2. Live memory: poll PIDs + `GetProcessMemoryInfo`; the job classes give peaks
   and threshold notifications only.
3. Transport: `node:net` named pipe, not `Bun.serve({unix})` (issue 15350 open).
   `FILE_FLAG_FIRST_PIPE_INSTANCE` comes free via libuv and gives squat
   detection.
4. Default pipe ACL is Everyone-readable and anonymous-readable. Ship a token
   file under `%LOCALAPPDATA%` with an explicit DACL, and plan a native add-on
   for `ImpersonateNamedPipeClient` if real peer authentication is required.
   AF_UNIX on Windows carries no peer credentials at all.
5. Chrome: plain `--headless`, private `--user-data-dir`,
   `--remote-debugging-port=0` and read `<user-data-dir>\DevToolsActivePort`.
   Locate the binary via `App Paths`.
6. ABE is off by construction in Orbit sessions (`kNotUsingDefaultUserDataDir`),
   which is the isolation win, and must be documented as "DPAPI only" for
   anything stored inside an Orbit profile.
7. Network confinement per process/job is not achievable from user mode; say so
   and implement it in Chrome's own proxy/resolver configuration instead.

---

## Things deliberately marked not confirmed

- CPU rate control behaviour on hybrid P/E core machines.
- Whether `--headless=new` is scheduled for removal as an accepted value.
- Whether `Bun.serve({ unix: <Windows filesystem path> })` is supported and
  tested end to end on Windows.
- Whether `fs.chmod(pipePath, 0)` reliably tightens a pipe DACL under Bun.
- Whether `msedge.exe` is registered under `App Paths`.
- Whether the default `%LOCALAPPDATA%` DACL excludes other standard users on
  every Windows SKU.
- Whether a headless Chrome *browser* process runs correctly inside an
  AppContainer.
- Any per-process "die when parent dies" flag equivalent to
  `PR_SET_PDEATHSIG`.
- Exact numeric values for the job information classes other than the five
  quoted above (2, 3, 6, 15, 34); read the rest from the SDK header.
