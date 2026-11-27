# Builds the Vela Android app (android/) into android/build/vela.apk with the Android SDK's own
# tools, no Gradle: aapt2 (resources + manifest), javac, d8 (dex), zipalign, apksigner.
#   -Web      also build the playground pages into android/assets/www first (vite build)
#   -Install  install the result on the connected device (adb) and start it
# Needs the Android SDK (platforms + build-tools; ANDROID_HOME, or the default location) and a JDK.
param([switch]$Web, [switch]$Install)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$app = Join-Path $root 'android'
$out = Join-Path $app 'build'
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$tools = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory | Sort-Object { [version]$_.Name } | Select-Object -Last 1 -ExpandProperty FullName
$platform = Get-ChildItem (Join-Path $sdk 'platforms') -Directory | Sort-Object { [int]($_.Name -replace '\D', '') } | Select-Object -Last 1 -ExpandProperty FullName
$androidJar = Join-Path $platform 'android.jar'
$adb = Join-Path $sdk 'platform-tools\adb.exe'

function Invoke-Tool([string]$exe) {
    & $exe @args
    if ($LASTEXITCODE -ne 0) { throw "$(Split-Path $exe -Leaf) failed ($LASTEXITCODE)" }
}

if ($Web) {
    Push-Location $root
    try { Invoke-Tool npx.cmd vite build } finally { Pop-Location } # vite.config.ts: the pages into android/assets/www
}

Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$out\gen", "$out\classes", "$out\dex" | Out-Null

# Resources and manifest.
Invoke-Tool "$tools\aapt2.exe" compile --dir "$app\res" -o "$out\res.zip"
$link = @('link', '-o', "$out\unsigned.apk", '-I', $androidJar, '--manifest', "$app\AndroidManifest.xml",
    '--min-sdk-version', '26', '--target-sdk-version', '29', '--java', "$out\gen", "$out\res.zip")
Invoke-Tool "$tools\aapt2.exe" @link

# Code.
$sources = @(Get-ChildItem "$app\src", "$out\gen" -Recurse -Filter *.java | ForEach-Object FullName)
Invoke-Tool javac -source 8 -target 8 '-Xlint:-options' -encoding UTF-8 -classpath $androidJar -d "$out\classes" @sources
$classes = @(Get-ChildItem "$out\classes" -Recurse -Filter *.class | ForEach-Object FullName)
Invoke-Tool "$tools\d8.bat" --min-api 26 --lib $androidJar --output "$out\dex" @classes
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open("$out\unsigned.apk", 'Update')
try {
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, "$out\dex\classes.dex", 'classes.dex') | Out-Null
    # The assets go in here rather than through aapt2, which names them with backslashes on Windows.
    if (Test-Path "$app\assets") {
        foreach ($file in Get-ChildItem "$app\assets" -Recurse -File) {
            $name = 'assets/' + $file.FullName.Substring("$app\assets\".Length).Replace('\', '/')
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $name) | Out-Null
        }
    }
} finally { $zip.Dispose() }

# Align and sign with the SDK's usual debug key (created on first use, kept outside the repo).
Invoke-Tool "$tools\zipalign.exe" -p -f 4 "$out\unsigned.apk" "$out\aligned.apk"
$ks = Join-Path $env:USERPROFILE '.android\debug.keystore'
if (-not (Test-Path $ks)) {
    New-Item -ItemType Directory -Force (Split-Path $ks) | Out-Null
    Invoke-Tool keytool -genkeypair -keystore $ks -storepass android -keypass android -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=Android Debug,O=Android,C=US'
}
Invoke-Tool "$tools\apksigner.bat" sign --ks $ks --ks-pass pass:android --key-pass pass:android --out "$out\vela.apk" "$out\aligned.apk"
"built $out\vela.apk ($([math]::Round((Get-Item "$out\vela.apk").Length / 1MB, 1)) MB)"

if ($Install) {
    Invoke-Tool $adb install -r "$out\vela.apk"
    Invoke-Tool $adb shell am start -n dev.vela.charts/.MainActivity
}
