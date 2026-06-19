!macro customInit
  nsExec::ExecToLog 'taskkill /IM Messenger.exe /F /T'
  nsExec::ExecToLog 'taskkill /IM Messeger.exe /F /T'
  Sleep 500
!macroend
