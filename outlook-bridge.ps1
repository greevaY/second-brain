# Bridge between Second Brain and Outlook (classic Outlook via COM, same Exchange mailbox as new Outlook).
#   -Action read   : prints busy events from the default Calendar as JSON
#   -Action write  : syncs the events in -InFile (JSON) into the "Second Brain" calendar.
#                    Only touches items it created (tagged with the SBKey property).
param(
  [string]$Action,
  [int]$Days = 21,
  [string]$InFile,
  [string]$CalendarName = 'Second Brain'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Fmt($d) { $d.ToString("yyyy-MM-dd'T'HH:mm") }
function Parse($s) { [datetime]::ParseExact($s, "yyyy-MM-dd'T'HH:mm", $null) }

try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace('MAPI')
  $cal = $ns.GetDefaultFolder(9)  # olFolderCalendar

  if ($Action -eq 'read') {
    $start = (Get-Date).Date
    $end = $start.AddDays($Days)
    $items = $cal.Items
    $items.Sort('[Start]')
    $items.IncludeRecurrences = $true
    $filter = "[Start] < '" + $end.ToString('g') + "' AND [End] > '" + $start.ToString('g') + "'"
    $out = @()
    foreach ($i in $items.Restrict($filter)) {
      if ($i.AllDayEvent) { continue }
      if ($i.BusyStatus -eq 0) { continue }  # marked Free
      $out += [pscustomobject]@{ start = (Fmt $i.Start); end = (Fmt $i.End); subject = [string]$i.Subject; categories = [string]$i.Categories }
    }
    @{ ok = $true; events = $out; total = $cal.Items.Count; mode = $ns.ExchangeConnectionMode } | ConvertTo-Json -Depth 4 -Compress
  }
  elseif ($Action -eq 'write') {
    # PS 5.1's ConvertFrom-Json emits a JSON array as ONE object; ForEach-Object unrolls it into items.
    $desired = @(Get-Content -Raw -Encoding UTF8 $InFile | ConvertFrom-Json | ForEach-Object { $_ })
    $folder = $null
    foreach ($f in $cal.Folders) { if ($f.Name -eq $CalendarName) { $folder = $f } }
    if (-not $folder) { $folder = $cal.Folders.Add($CalendarName, 9) }

    $want = @{}
    foreach ($e in $desired) { if ($e.key) { $want[$e.key] = $e } }
    # Create any category we were given a color for that doesn't exist yet (never recolors existing ones).
    $have = @{}; foreach ($c in $ns.Categories) { $have[$c.Name] = $true }
    foreach ($e in $desired) {
      if ($e.categories -and $e.categoryColor -and -not $have[[string]$e.categories]) {
        [void]$ns.Categories.Add([string]$e.categories, [int]$e.categoryColor); $have[[string]$e.categories] = $true
      }
    }
    function Apply($it, $e) {
      $it.Categories = [string]$e.categories
      $it.Subject = $e.subject
      $it.Start = Parse $e.start
      $it.End = Parse $e.end
      $it.Body = [string]$e.body
      $it.BusyStatus = [int]$e.busyStatus
      $it.ReminderSet = $true
      $it.ReminderMinutesBeforeStart = [int]$e.reminder
    }

    $now = Get-Date
    $seen = @{}; $added = 0; $updated = 0; $deleted = 0
    $existing = @(); foreach ($it in $folder.Items) { $existing += $it }
    foreach ($it in $existing) {
      $p = $it.UserProperties.Find('SBKey')
      if (-not $p) { continue }
      $k = [string]$p.Value
      $isPast = $it.End -lt $now
      if (-not $want.ContainsKey($k) -or $seen.ContainsKey($k)) {
        if ($isPast) { continue }  # keep history of past study sessions
        $it.Delete(); $deleted++; continue
      }
      $seen[$k] = $true
      $e = $want[$k]
      if ((Fmt $it.Start) -ne $e.start -or (Fmt $it.End) -ne $e.end -or $it.Subject -ne $e.subject -or $it.BusyStatus -ne [int]$e.busyStatus -or $it.Categories -ne [string]$e.categories) {
        Apply $it $e; $it.Save(); $updated++
      }
    }
    foreach ($k in $want.Keys) {
      if ($seen.ContainsKey($k)) { continue }
      $it = $folder.Items.Add(1)  # olAppointmentItem
      $prop = $it.UserProperties.Add('SBKey', 1, $false)  # olText
      $prop.Value = $k
      Apply $it $want[$k]
      $it.Save(); $added++
    }
    try { $ns.SendAndReceive($false) } catch {}
    Start-Sleep -Seconds 5  # give Outlook a moment to upload before we release it
    @{ ok = $true; added = $added; updated = $updated; deleted = $deleted; calendar = $CalendarName; mode = $ns.ExchangeConnectionMode } | ConvertTo-Json -Compress
  }
  else {
    @{ ok = $false; error = "unknown action '$Action'" } | ConvertTo-Json -Compress
  }
}
catch {
  @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
