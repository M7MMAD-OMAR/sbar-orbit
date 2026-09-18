$ErrorActionPreference = 'Continue'
$out = 'C:\orbit\suite-0918.log'
$text = Get-Content $out -Raw
$lines = $text -split "`r?`n"
# Print each failure with the lines around it, which is where the error text is.
for ($i = 0; $i -lt $lines.Length; $i++) {
  if ($lines[$i] -match '^\(fail\)') {
    Say "################ $($lines[$i].Trim())"
    $start = [Math]::Max(0, $i - 26)
    for ($j = $start; $j -lt $i; $j++) {
      $l = $lines[$j].Trim()
      if ($l -and $l -notmatch '^\(pass\)') { Say "  | $l" }
    }
  }
}
Say "DONE"
