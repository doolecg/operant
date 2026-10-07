// Stand-in for an IDE: records the folder it was asked to open (the last argument) in the file named by FAKE_IDE_OUT.
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.FAKE_IDE_OUT, `${process.argv.at(-1)}\n`)
