import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'

const steps = [
  { name: 'pdf-parse', command: 'npm run scan:pdf' },
  { name: 'full-flow', command: 'npm run scan:flow' },
  { name: 'unit-test', command: 'npm run test' },
  { name: 'build', command: 'npm run build' },
]

const runCommand = (command) =>
  new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(command, { shell: true, stdio: 'inherit' })
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        elapsedMs: Date.now() - startedAt,
      })
    })
  })

const run = async () => {
  const results = []
  for (const step of steps) {
    const result = await runCommand(step.command)
    results.push({
      step: step.name,
      command: step.command,
      ...result,
    })
    if (result.code !== 0) break
  }

  const report = {
    ok: results.every((result) => result.code === 0),
    createdAt: new Date().toISOString(),
    results,
  }

  await fs.mkdir('ui-scan', { recursive: true })
  await fs.writeFile('ui-scan/quality-gate-report.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))

  if (!report.ok) process.exit(1)
}

run().catch((error) => {
  console.error('[quality-gate] failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
