; Sandflow - extra steps for the Windows (NSIS) installer, included via electron-builder.yml > nsis.include.
;
; After the files are in place, check for what Sandflow needs on the machine (git, and Docker or Podman for the
; agents' sandbox) and offer to open the download pages. The sandbox image itself ships inside the app and is
; loaded on first start, so nothing is downloaded here. Skipped for silent installs (auto-update, /S).

!macro sandflowHas NAME VAR
  nsExec::ExecToStack '"$SYSDIR\cmd.exe" /c where ${NAME}'
  Pop ${VAR}
  Pop $R9
!macroend

!macro customInstall
  ${IfNot} ${Silent}
    StrCpy $R0 ""
    !insertmacro sandflowHas "git" $R3
    ${If} $R3 != 0
      StrCpy $R0 "$R0$\r$\n  - Git - needed for every flow (git-scm.com)"
    ${EndIf}
    !insertmacro sandflowHas "docker" $R1
    !insertmacro sandflowHas "podman" $R2
    ${If} $R1 != 0
    ${AndIf} $R2 != 0
      StrCpy $R0 "$R0$\r$\n  - Docker Desktop or Podman - runs the AI agents in a sandbox$\r$\n     (or choose Settings > Sandbox > None to run them directly on this PC)"
    ${EndIf}
    ${If} $R0 != ""
      MessageBox MB_YESNO|MB_ICONINFORMATION "Sandflow is installed. It also needs these, which weren't found on this PC:$\r$\n$R0$\r$\n$\r$\nOpen their download pages now?" IDNO sandflowPrereqsDone
        ${If} $R1 != 0
        ${AndIf} $R2 != 0
          ExecShell "open" "https://www.docker.com/products/docker-desktop/"
        ${EndIf}
        ${If} $R3 != 0
          ExecShell "open" "https://git-scm.com/download/win"
        ${EndIf}
      sandflowPrereqsDone:
    ${EndIf}
  ${EndIf}
!macroend
