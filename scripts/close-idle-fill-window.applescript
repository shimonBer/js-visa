tell application "Terminal"
  repeat with w in windows
    try
      if name of w contains "Fill DS-160" or name of w contains "fill-ds160" then
        if (busy of selected tab of w) is false then close w
      end if
    end try
  end repeat
end tell
