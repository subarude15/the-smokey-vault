Get-Content .env.aider | ForEach-Object {
    if ($_ -match "^([^=]+)=(.*)$") {
        [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
    }
}

aider `
  --model openrouter/deepseek/deepseek-r1 `
  --editor-model openrouter/deepseek/deepseek-chat `
  --architect `
  --read .spec/target-state.md `
  --auto-commits `
  $args
