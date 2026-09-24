// Cerebriline sandbox — milestone 1 launcher.
//
// Starts a target command with hook.dll already loaded, using Detours'
// DetourCreateProcessWithDllExW. The hook DLL then re-injects itself into any
// child the target spawns, so the whole process tree runs under the hook.
//
// Usage:
//   sandbox-launch.exe <hook.dll path> <log file path> <command...>
// Example:
//   sandbox-launch.exe hook.dll run.log cmd /c "node -e ""require('fs').readFileSync('x')"""
//
// Milestone 1 is observe-only: the DLL logs every file open to the log file.
// The launcher's own job (start suspended + inject + resume + wait) is the
// same on every later milestone; only the DLL changes.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <detours.h>
#include <cstdio>
#include <string>

static std::wstring JoinArgs(int argc, wchar_t** argv, int first) {
    // Rebuild a command line from argv[first..], quoting args with spaces.
    std::wstring out;
    for (int i = first; i < argc; ++i) {
        if (!out.empty()) out += L' ';
        const wchar_t* a = argv[i];
        bool needQuote = (wcschr(a, L' ') != nullptr) || a[0] == L'\0';
        if (needQuote) out += L'"';
        out += a;
        if (needQuote) out += L'"';
    }
    return out;
}

int wmain(int argc, wchar_t** argv) {
    if (argc < 4) {
        fwprintf(stderr, L"usage: %s <hook.dll> <logfile> <command...>\n", argv[0]);
        return 2;
    }

    const wchar_t* dllPath = argv[1];
    const wchar_t* logPath = argv[2];

    // The DLL reads its log path from this env var (inherited by the child).
    SetEnvironmentVariableW(L"CEREBRILINE_SANDBOX_LOG", logPath);

    char dllA[MAX_PATH];
    if (WideCharToMultiByte(CP_ACP, 0, dllPath, -1, dllA, sizeof(dllA), nullptr, nullptr) == 0) {
        fwprintf(stderr, L"bad dll path\n");
        return 2;
    }

    std::wstring cmd = JoinArgs(argc, argv, 3);
    std::wstring cmdMutable = cmd;  // CreateProcess may write to the buffer.

    STARTUPINFOW si = { sizeof(si) };
    PROCESS_INFORMATION pi = {};

    BOOL ok = DetourCreateProcessWithDllExW(
        nullptr, &cmdMutable[0], nullptr, nullptr, TRUE,
        CREATE_DEFAULT_ERROR_MODE | CREATE_UNICODE_ENVIRONMENT,
        nullptr, nullptr, &si, &pi, dllA, nullptr);

    if (!ok) {
        fwprintf(stderr, L"DetourCreateProcessWithDllExW failed: %lu\n", GetLastError());
        return 3;
    }

    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 0;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return (int)code;
}
