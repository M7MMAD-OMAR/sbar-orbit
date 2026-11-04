$ErrorActionPreference = 'Stop'
$memory = Get-CimInstance Win32_OperatingSystem
$processors = @(Get-CimInstance Win32_Processor)
$free = [int64]$memory.FreePhysicalMemory * 1024
$total = [int64]$memory.TotalVisibleMemorySize * 1024
$load = ($processors | Measure-Object -Property LoadPercentage -Average).Average
$required = [Math]::Max(3GB, [Math]::Floor($total * 0.40))
@{ availableBytes=$free; totalBytes=$total; cpuLoadPercent=$load; minimumFreeBytes=$required; maximumParallelBuilds=2 } | ConvertTo-Json -Compress
if ($free -lt $required -or $load -gt 85) { throw 'Windows build resource reserve is not available; no other processes will be killed' }
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'
$env:DOTNET_PROCESSOR_COUNT = '2'
