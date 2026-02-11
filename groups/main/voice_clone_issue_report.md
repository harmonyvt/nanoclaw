# Voice Clone Twitch Download Issue Report

**Date:** 2026-02-11
**Reporter:** Yoona (AI Agent)
**Severity:** Medium - Feature blocked
**Component:** Voice cloning workflow / Media download pipeline

---

## Summary

Attempted to download and process a Twitch clip for voice cloning but encountered multiple blocking issues related to missing Python runtime and Twitch CDN authentication requirements.

**Target URL:** `https://www.twitch.tv/yawn/clip/VivaciousPopularDugongCharlietheUnicorn-37gnhg5uSAbYvKdX`

**Objective:** Download audio from Twitch clip, process to 24kHz mono WAV format, transcribe, and configure voice cloning profile.

---

## Environment Details

### System Information
- **Kernel:** Linux 4d92032e3a17 6.17.8-orbstack (aarch64)
- **User:** bun (uid=1000, gid=1000)
- **Shell:** /bin/bash
- **Working Directory:** /workspace/group
- **Disk Space:** 71G available (26% used)

### Installed Tools
- ✅ **curl:** /usr/bin/curl (available)
- ✅ **ffmpeg:** /usr/bin/ffmpeg (available, but version check failed)
- ✅ **yt-dlp:** /usr/local/bin/yt-dlp (installed but non-functional)
- ❌ **python/python3:** NOT FOUND
- ❌ **pip/pip3:** NOT FOUND
- ❌ **wget:** NOT FOUND
- ❌ **streamlink:** NOT FOUND

### Permission Status
- **User permissions:** Non-root (uid=1000)
- **apt-get:** Permission denied for package installation
- **Directory creation:** Failed to create `/root/Downloads` (Permission denied)

---

## Attempted Solutions

### 1. Direct yt-dlp Execution (FAILED)
**Command:**
```bash
yt-dlp -x --audio-format wav -o "/workspace/group/media/ref_voice_raw.%(ext)s" "https://www.twitch.tv/yawn/clip/..."
```

**Error:**
```
env: 'python3': No such file or directory
Exit code 127
```

**Root Cause:** yt-dlp is a Python script that requires Python 3.7+ to execute. Python is not installed in the container.

---

### 2. Package Installation Attempt (FAILED)
**Commands:**
```bash
apt-get update
apt-get install -y python3 python3-pip
```

**Errors:**
```
E: List directory /var/lib/apt/lists/partial is missing. - Acquire (13: Permission denied)
E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)
E: Unable to acquire the dpkg frontend lock
```

**Root Cause:** Container user 'bun' does not have sudo/root privileges to install packages.

---

### 3. CUA Browser Sandbox with yt-dlp (PARTIAL SUCCESS)
**Approach:** Opened terminal in CUA browser sandbox, downloaded yt-dlp binary, executed download.

**Commands:**
```bash
wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /tmp/yt-dlp
chmod +x /tmp/yt-dlp
/tmp/yt-dlp -x --audio-format wav -o "/tmp/ref_voice_raw.%(ext)s" "URL"
```

**Result:** ✅ Successfully downloaded clip to `/tmp/ref_voice_raw.wav` (21.43MB, ~1 minute duration)

**Processing:**
```bash
ffmpeg -i /tmp/ref_voice_raw.wav -ar 24000 -ac 1 -t 10 -y /tmp/voice_ref.wav
```
**Result:** ✅ Successfully processed to 24kHz mono WAV (469KB, 10 seconds)

**File Extraction:** ❌ FAILED
```bash
browse_extract_file({ path: "/tmp/voice_ref.wav" })
browse_extract_file({ path: "/root/voice_ref.wav" })
```
**Error:** `File not found or cannot stat`

**Root Cause:** File extraction from CUA sandbox appears to have path resolution issues or the file wasn't properly accessible from the extraction mechanism.

---

### 4. Twitch GraphQL API Method (PARTIAL SUCCESS)
**Approach:** Query Twitch's GraphQL API to get direct MP4 URLs.

**Command:**
```bash
curl -s 'https://gql.twitch.tv/gql' \
  -H 'Client-ID: kimne78kx3ncx6brgo4mv6wki5h1ko' \
  -H 'Content-Type: application/json' \
  --data-raw '{"query":"query{clip(slug:\"VivaciousPopularDugongCharlietheUnicorn-37gnhg5uSAbYvKdX\"){videoQualities{sourceURL}}}"}'
```

**Result:** ✅ Successfully retrieved URLs:
- `https://production.assets.clips.twitchcdn.net/.../video-720.mp4`
- `https://production.assets.clips.twitchcdn.net/.../video-480.mp4`
- `https://production.assets.clips.twitchcdn.net/.../video-360.mp4`

**Download Attempt:**
```bash
curl -L "URL" -o /workspace/group/media/twitch_clip.mp4
```

**Error:**
```
HTTP/1.1 401 Unauthorized
Server: CloudFront
X-Cache: LambdaGeneratedResponse from cloudfront
```

**Download with Headers:**
```bash
curl -L -A "Mozilla/5.0..." -H "Referer: https://www.twitch.tv/" "URL" -o file.mp4
```

**Result:** ❌ Still failed - 0 byte file downloaded

**Root Cause:** Twitch CDN requires authentication or signed URLs. Direct download without proper session/signature is rejected with 401.

---

## Root Cause Analysis

### Primary Issues
1. **Missing Python Runtime** - yt-dlp requires Python 3.7+ which is not installed
2. **Insufficient Permissions** - Cannot install packages via apt-get (non-root user)
3. **Twitch CDN Authentication** - Direct MP4 URLs require authenticated requests or signed URLs
4. **CUA File Extraction Issues** - Cannot reliably extract files from CUA sandbox to main container

### Secondary Issues
- No alternative download tools (wget, streamlink, etc.)
- Limited debugging tools (file command not found)
- Path permission issues between CUA sandbox and main container

---

## Recommendations

### Immediate Solutions

#### Option 1: Install Python in Container (Preferred)
Add Python to the container base image or install via a privileged init script:
```dockerfile
RUN apt-get update && apt-get install -y python3 python3-pip
```

#### Option 2: Use Standalone yt-dlp Binary
Download the standalone yt-dlp binary that doesn't require Python:
```bash
# Note: Standalone binary exists but may not work on all architectures
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp-standalone
```

#### Option 3: Fix CUA File Extraction
Investigate and fix the `browse_extract_file` mechanism to properly handle files from the CUA sandbox. The files are being created successfully but extraction fails.

#### Option 4: Implement Twitch-Specific Download Service
Create a dedicated service/endpoint that handles Twitch clip downloads with proper authentication:
- Use Twitch API with OAuth tokens
- Implement signed URL generation
- Proxy downloads through authenticated service

### Workarounds for Users

Until resolved, users can:
1. **Download clips manually** and upload the audio/video file directly
2. **Use alternative sources** (YouTube, direct audio files, etc.)
3. **Use preset voices** instead of voice cloning
4. **Provide audio files from other platforms** that don't require authentication

---

## Additional Context

### Successful Workaround in CUA Sandbox
The process **does work** in the CUA browser sandbox environment:
- yt-dlp can be downloaded and executed
- ffmpeg processing works correctly
- Files are created successfully

**The bottleneck** is extracting these files from the CUA environment back to the main container for further processing (transcription, voice profile creation).

### Voice Cloning Workflow Requirements
For successful voice cloning, we need:
1. ✅ Audio download (works in CUA)
2. ✅ Processing to 24kHz mono WAV (works in CUA)
3. ❌ File extraction to main container (BLOCKED)
4. ❓ Transcription via OpenAI Whisper API (untested - requires file from step 3)
5. ❓ Voice profile JSON creation (untested - requires transcript from step 4)
6. ❓ Test voice message generation (untested - requires profile from step 5)

---

## Priority Recommendations

### High Priority
1. **Install Python 3** in the main container to enable yt-dlp functionality
2. **Fix CUA file extraction** mechanism to enable sandbox-based workflows

### Medium Priority
3. Add wget/curl alternatives for better download options
4. Grant package installation permissions or provide pre-installed tools

### Low Priority
5. Implement Twitch-specific authenticated download service
6. Add better error messages for missing dependencies

---

## Test Case for Verification

Once resolved, verify with:
```bash
# Should work without Python errors
yt-dlp -x --audio-format wav -o "/tmp/test.wav" "https://www.twitch.tv/yawn/clip/VivaciousPopularDugongCharlietheUnicorn-37gnhg5uSAbYvKdX"

# Should process successfully
ffmpeg -i /tmp/test.wav -ar 24000 -ac 1 -t 10 -y /workspace/group/media/voice_ref.wav

# Should transcribe
transcribe_audio({ path: "/workspace/group/media/voice_ref.wav" })
```

---

**End of Report**
