/** Genera i modelli di importazione in /templates (gli stessi scaricabili dall'applicazione). */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { FIELDS, type ImportType } from '../services/imports/fields'

const dir = join(process.cwd(), '..', '..', 'templates')
for (const type of ['ingredients', 'employees'] as ImportType[]) {
  const fields = FIELDS[type]
  const name = type === 'ingredients' ? 'modello-ingredienti' : 'modello-dipendenti'
  await writeFile(join(dir, `${name}.csv`), `﻿${fields.map((f) => f.label).join(';')}\r\n${fields.map((f) => f.example).join(';')}\r\n`)
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Dati')
  ws.addRow(fields.map((f) => f.label)).font = { bold: true }
  ws.addRow(fields.map((f) => f.example))
  fields.forEach((f, i) => (ws.getColumn(i + 1).width = Math.max(14, f.label.length + 4)))
  const help = wb.addWorksheet('Istruzioni')
  help.addRow(['Colonna', 'Obbligatoria', 'Descrizione', 'Esempio']).font = { bold: true }
  for (const f of fields) help.addRow([f.label, f.required ? 'sì' : 'no', f.help, f.example])
  help.getColumn(3).width = 90
  await wb.xlsx.writeFile(join(dir, `${name}.xlsx`))
  console.log(`scritti ${name}.csv e ${name}.xlsx`)
}
