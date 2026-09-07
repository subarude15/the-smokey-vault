Get-Content .env.aider | ForEach-Object {
    if ($_ -match "^([^=]+)=(.*)$") {
        [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
    }
}

aider `
  --model openrouter/deepseek/deepseek-r1 `
  --chat-mode ask `
  --read .spec/target-state.md `
  --read .spec/ARCHITECT_INSTRUCTIONS.md `
  --read ROADMAP.md `
  --no-auto-commits
