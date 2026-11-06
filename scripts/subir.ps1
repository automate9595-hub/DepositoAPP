# DepositoAPP - subida automatica a GitHub (sin Git ni Node.js). Solo usa PowerShell de Windows (3.0 o superior).
# Archivo en ASCII a proposito (sin tildes) para que funcione igual en cualquier Windows.
$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$Owner  = 'automate9595-hub'
$Repo   = 'DepositoAPP'
$Branch = 'main'
$Root   = Split-Path -Parent $PSScriptRoot
$Api    = "https://api.github.com/repos/$Owner/$Repo"
$TokenFile = Join-Path $env:APPDATA 'DepositoAPP\token.dat'
$script:Token = $null

# Escritura tolerante: si la consola de Windows rechaza colores o posicion del cursor, escribe en texto simple
function Out-Safe([string]$t, [string]$color = '', [bool]$nonl = $false) {
    try {
        if ($color -and $nonl) { Write-Host $t -ForegroundColor $color -NoNewline }
        elseif ($color) { Write-Host $t -ForegroundColor $color }
        elseif ($nonl) { Write-Host $t -NoNewline }
        else { Write-Host $t }
    } catch {
        try { if ($nonl) { [Console]::Write($t) } else { [Console]::WriteLine($t) } } catch { }
    }
}
function Say([string]$t, [string]$color = 'Gray') { Out-Safe $t $color }

function Show-Bar([int]$done, [int]$total, [string]$label) {
    if ($total -le 0) { $total = 1 }
    $w = 30
    $pct = [int](100 * $done / $total)
    $fill = [int]($w * $done / $total)
    $bar = ('#' * $fill) + ('-' * ($w - $fill))
    $line = "  [$bar] $pct% ($done/$total) $label"
    if ($line.Length -gt 78) { $line = $line.Substring(0, 78) }
    Out-Safe ("`r" + $line.PadRight(78)) '' $true
}

function Call-Api([string]$method, [string]$url, $body = $null, [int]$tries = 3) {
    $h = @{ Authorization = "token $script:Token"; 'User-Agent' = 'DepositoAPP-uploader'; Accept = 'application/vnd.github+json' }
    for ($i = 1; $i -le $tries; $i++) {
        try {
            if ($body -ne $null) {
                $json = ConvertTo-Json -InputObject $body -Depth 10 -Compress
                return Invoke-RestMethod -Method $method -Uri $url -Headers $h -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($json))
            }
            return Invoke-RestMethod -Method $method -Uri $url -Headers $h
        } catch {
            $code = 0; $msg = $_.Exception.Message
            if ($_.Exception.Response) {
                $code = [int]$_.Exception.Response.StatusCode
                try { $sr = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream()); $msg = $sr.ReadToEnd() } catch { }
            }
            if (($code -in 401, 403, 404, 409, 422) -or ($i -ge $tries)) { throw (New-Object Exception("HTTP $code : $msg")) }
            Start-Sleep -Seconds (2 * $i)
        }
    }
}

# ---------- Token (se guarda cifrado para el usuario de Windows) ----------
function Get-SavedToken {
    if (Test-Path $TokenFile) {
        try {
            $s = Get-Content $TokenFile | ConvertTo-SecureString
            $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
            return [Runtime.InteropServices.Marshal]::PtrToStringAuto($b)
        } catch { }
    }
    return $null
}
function Save-Token([string]$t) {
    $d = Split-Path $TokenFile
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null }
    ConvertTo-SecureString $t -AsPlainText -Force | ConvertFrom-SecureString | Set-Content $TokenFile
}
function Ask-Token {
    Out-Safe ''
    Say '  Se necesita un "token" de GitHub (se pide UNA sola vez y queda guardado cifrado en este equipo).' 'Yellow'
    Say '  1. Se abrira la pagina de GitHub para crearlo (inicie sesion si lo pide).'
    Say '  2. Deje marcados "repo" y "workflow", baje y pulse "Generate token".'
    Say '  3. Copie el codigo que empieza con ghp_ y peguelo aqui (no se vera al pegarlo).'
    Out-Safe ''
    try { Start-Process 'https://github.com/settings/tokens/new?scopes=repo,workflow&description=DepositoAPP-subida' } catch { }
    $sec = Read-Host '  Pegue el token y pulse Enter' -AsSecureString
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    return ([Runtime.InteropServices.Marshal]::PtrToStringAuto($b)).Trim()
}

function Blob-Sha([byte[]]$bytes) {
    $hdr = [Text.Encoding]::ASCII.GetBytes("blob $($bytes.Length)`0")
    $all = New-Object byte[] ($hdr.Length + $bytes.Length)
    [Array]::Copy($hdr, 0, $all, 0, $hdr.Length)
    [Array]::Copy($bytes, 0, $all, $hdr.Length, $bytes.Length)
    $sha = [Security.Cryptography.SHA1]::Create()
    return (($sha.ComputeHash($all) | ForEach-Object { $_.ToString('x2') }) -join '')
}

try {
    try { Clear-Host } catch { }
    Say '==================================================' 'Cyan'
    Say '   DEPOSITOAPP - SUBIDA AUTOMATICA A GITHUB' 'Cyan'
    Say '==================================================' 'Cyan'
    Say "   Repositorio: $Owner/$Repo   Rama: $Branch"
    Out-Safe ''

    if (-not (Test-Path (Join-Path $Root 'docs\index.html'))) { throw 'No se encuentra docs\index.html. Ejecute este archivo desde la carpeta del proyecto.' }

    # ---------- 1. Conexion ----------
    Say '[1/5] Conectando con GitHub...' 'White'
    $script:Token = Get-SavedToken
    $info = $null
    for ($try = 1; $try -le 3 -and -not $info; $try++) {
        if (-not $script:Token) { $script:Token = Ask-Token; $fresh = $true } else { $fresh = $false }
        try { $info = Call-Api 'GET' $Api } catch {
            if ($_.Exception.Message -match 'HTTP (401|403|404)') {
                Say '  GitHub no acepto ese token (o no tiene acceso al repositorio).' 'Red'
                if (Test-Path $TokenFile) { Remove-Item $TokenFile -Force }
                $script:Token = $null
            } else { throw }
        }
    }
    if (-not $info) { throw 'No se pudo iniciar sesion en GitHub. Cree un token con permisos "repo" y "workflow" e intente de nuevo.' }
    if ($info.permissions -and -not $info.permissions.push) { throw 'Ese token no tiene permiso de escritura en el repositorio.' }
    if ($fresh) { Save-Token $script:Token }
    Say '      Conexion correcta.' 'Green'

    # ---------- 2. Archivos locales ----------
    Say '[2/5] Revisando archivos del proyecto...' 'White'
    $rootLen = $Root.TrimEnd('\').Length + 1
    $local = @()
    Get-ChildItem -LiteralPath $Root -Recurse -File -Force | ForEach-Object {
        $rel = $_.FullName.Substring($rootLen)
        if ($rel -match '^(\.git|node_modules|_site)(\\|$)') { return }
        if ($rel -eq '.env' -or $_.Extension -eq '.zip' -or $_.Length -gt 50MB) { return }
        $local += New-Object PSObject -Property @{ Rel = ($rel -replace '\\', '/'); Full = $_.FullName }
    }
    if ($local.Count -eq 0) { throw 'No se encontraron archivos para subir.' }
    Say ("      {0} archivos en el proyecto." -f $local.Count) 'Green'

    # ---------- 3. Comparar con GitHub ----------
    Say '[3/5] Comparando con lo que ya hay en GitHub...' 'White'
    $ref = $null
    try { $ref = Call-Api 'GET' "$Api/git/ref/heads/$Branch" } catch { if ($_.Exception.Message -notmatch 'HTTP (404|409)') { throw } }
    if (-not $ref) {
        Say '      El repositorio esta vacio: se inicializa primero.' 'Yellow'
        $seed = @{ message = 'Inicio del repositorio'; content = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('DepositoAPP')); branch = $Branch }
        Call-Api 'PUT' "$Api/contents/.deposito-init" $seed | Out-Null
        $ref = Call-Api 'GET' "$Api/git/ref/heads/$Branch"
    }
    $parent = $ref.object.sha
    $commit = Call-Api 'GET' "$Api/git/commits/$parent"
    $baseTree = $commit.tree.sha
    $remote = @{}
    $tree = Call-Api 'GET' "$Api/git/trees/${baseTree}?recursive=1"
    if (-not $tree.truncated) { foreach ($t in $tree.tree) { if ($t.type -eq 'blob') { $remote[$t.path] = $t.sha } } }

    $changed = @(); $same = 0; $n = 0
    foreach ($f in $local) {
        $n++
        Show-Bar $n $local.Count 'comparando...'
        $bytes = [IO.File]::ReadAllBytes($f.Full)
        $sha = Blob-Sha $bytes
        if ($remote[$f.Rel] -eq $sha) { $same++ } else { $changed += New-Object PSObject -Property @{ Rel = $f.Rel; Bytes = $bytes } }
    }
    Out-Safe ''
    Say ("      {0} sin cambios, {1} para subir." -f $same, $changed.Count) 'Green'
    if ($changed.Count -eq 0) {
        Out-Safe ''
        Say '  Todo esta al dia: GitHub ya tiene la ultima version. No hay nada que subir.' 'Green'
        Out-Safe ''
        exit 0
    }

    # ---------- 4. Subir archivos ----------
    Say '[4/5] Subiendo archivos a GitHub...' 'White'
    $entries = @(); $i = 0
    foreach ($f in $changed) {
        $i++
        Show-Bar ($i - 1) $changed.Count $f.Rel
        $blob = Call-Api 'POST' "$Api/git/blobs" @{ content = [Convert]::ToBase64String($f.Bytes); encoding = 'base64' }
        $entries += @{ path = $f.Rel; mode = '100644'; type = 'blob'; sha = $blob.sha }
        Show-Bar $i $changed.Count $f.Rel
    }
    Out-Safe ''
    Say '      Creando la nueva version...' 'Gray'
    $newTree = Call-Api 'POST' "$Api/git/trees" @{ base_tree = $baseTree; tree = $entries }
    $msg = 'DepositoAPP: actualizacion ' + (Get-Date -Format 'yyyy-MM-dd HH:mm')
    $newCommit = Call-Api 'POST' "$Api/git/commits" @{ message = $msg; tree = $newTree.sha; parents = @($parent) }
    Call-Api 'PATCH' "$Api/git/refs/heads/$Branch" @{ sha = $newCommit.sha; force = $false } | Out-Null
    Say ("      Subida completa: {0} archivos." -f $changed.Count) 'Green'

    # ---------- 5. Publicacion ----------
    Say '[5/5] Publicando la aplicacion (GitHub Pages)...' 'White'
    try { Call-Api 'POST' "$Api/pages" @{ build_type = 'workflow' } 1 | Out-Null } catch {
        try { Call-Api 'PUT' "$Api/pages" @{ build_type = 'workflow' } 1 | Out-Null } catch { }
    }
    $spin = '|', '/', '-', '\'
    $start = Get-Date; $result = $null; $k = 0; $status = 'esperando'
    while (((Get-Date) - $start).TotalSeconds -lt 300) {
        if ($k % 10 -eq 0) {
            try {
                $runs = Call-Api 'GET' "$Api/actions/runs?head_sha=$($newCommit.sha)" $null 1
                if ($runs.workflow_runs.Count -gt 0) {
                    $r = $runs.workflow_runs[0]
                    $status = if ($r.status -eq 'completed') { 'terminando' } elseif ($r.status -eq 'in_progress') { 'compilando y publicando' } else { 'en cola' }
                    if ($r.status -eq 'completed') { $result = $r.conclusion; break }
                }
            } catch { }
        }
        $secs = [int]((Get-Date) - $start).TotalSeconds
        Out-Safe (("`r  " + $spin[$k % 4] + " " + $status + "... " + $secs + " s").PadRight(60)) '' $true
        $k++; Start-Sleep -Milliseconds 500
    }
    Out-Safe ''
    Out-Safe ''
    if ($result -eq 'success') {
        Say '==================================================' 'Green'
        Say '   LISTO. La aplicacion se subio y esta publicada.' 'Green'
        Say '==================================================' 'Green'
    } elseif ($result) {
        Say "  Los archivos se subieron, pero la publicacion termino con estado: $result" 'Red'
        Say "  Revise: https://github.com/$Owner/$Repo/actions" 'Yellow'
        Say '  Si dice que Pages no esta activado: Settings > Pages > Source: GitHub Actions.' 'Yellow'
    } else {
        Say '  Los archivos se subieron. La publicacion sigue en curso (puede tardar unos minutos).' 'Yellow'
        Say "  Estado: https://github.com/$Owner/$Repo/actions" 'Yellow'
    }
    Out-Safe ''
    Say "  Direccion de la app: https://$Owner.github.io/$Repo/" 'Cyan'
    Say '  En el celular: abra esa direccion; la app se actualiza sola en unos minutos.' 'Gray'
    Out-Safe ''
    exit 0
} catch {
    Out-Safe ''
    Out-Safe ''
    Say '--------------------------------------------------' 'Red'
    Say ('  ERROR: ' + $_.Exception.Message) 'Red'
    if ($_.Exception.Message -match 'workflow') { Say '  El token necesita el permiso "workflow". Borre el guardado (token.dat) y cree uno nuevo con "repo" y "workflow".' 'Yellow' }
    Say '--------------------------------------------------' 'Red'
    Out-Safe ''
    exit 1
}
