'use strict'

const fs = require('fs')
const path = require('path')
const {
  createCorrectionTable,
  normalizeTable
} = require('./correction-table')

class TableStore {
  constructor (filePath, options = {}) {
    this.filePath = filePath
    this.options = options
    this.state = {
      learningEnabled: false,
      table: createCorrectionTable(options)
    }
  }

  load () {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      this.state = {
        learningEnabled: Boolean(parsed.learningEnabled),
        table: normalizeTable(parsed.table, this.options)
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      this.state = {
        learningEnabled: false,
        table: createCorrectionTable(this.options)
      }
      this.save()
    }
    return this.state
  }

  save () {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmpPath, `${JSON.stringify(this.state, null, 2)}\n`)
    fs.renameSync(tmpPath, this.filePath)
  }

  table () {
    return this.state.table
  }

  setTable (table) {
    this.state.table = normalizeTable(table, this.options)
    this.save()
    return this.state.table
  }

  resetTable () {
    this.state.table = createCorrectionTable(this.options)
    this.save()
    return this.state.table
  }

  learningEnabled () {
    return this.state.learningEnabled
  }

  setLearningEnabled (enabled) {
    this.state.learningEnabled = Boolean(enabled)
    this.save()
    return this.state.learningEnabled
  }
}

function createTableStore (app, pluginId, options = {}) {
  let root
  if (app && typeof app.getDataDirPath === 'function') {
    root = app.getDataDirPath()
  } else {
    root = path.join(process.cwd(), 'data')
  }
  return new TableStore(path.join(root, pluginId, 'correction-table.json'), options)
}

module.exports = {
  TableStore,
  createTableStore
}
