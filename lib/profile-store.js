'use strict'

const fs = require('fs')
const path = require('path')

class ProfileStore {
  constructor (filePath) {
    this.filePath = filePath
    this.state = {
      profiles: [],
      activeProfileId: null,
      lastCalibrationReport: null
    }
  }

  load () {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      this.state = {
        profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
        activeProfileId: parsed.activeProfileId || null,
        lastCalibrationReport: parsed.lastCalibrationReport || null
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    return this.state
  }

  save () {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`)
  }

  list () {
    return this.state.profiles
  }

  get (id) {
    return this.state.profiles.find(profile => profile.id === id) || null
  }

  upsert (profile) {
    const index = this.state.profiles.findIndex(item => item.id === profile.id)
    if (index === -1) this.state.profiles.push(profile)
    else this.state.profiles[index] = profile
    this.state.lastCalibrationReport = profile
    this.save()
    return profile
  }

  activate (id) {
    let activated = null
    this.state.profiles = this.state.profiles.map(profile => {
      if (profile.id === id) {
        activated = { ...profile, state: 'active', activatedAt: new Date().toISOString() }
        return activated
      }
      if (profile.state === 'active') {
        return { ...profile, state: 'archived', archivedAt: new Date().toISOString() }
      }
      return profile
    })
    if (!activated) return null
    this.state.activeProfileId = id
    this.save()
    return activated
  }

  archive (id) {
    const profile = this.get(id)
    if (!profile) return null
    const archived = { ...profile, state: 'archived', archivedAt: new Date().toISOString() }
    this.upsert(archived)
    if (this.state.activeProfileId === id) this.state.activeProfileId = null
    this.save()
    return archived
  }

  reject (id) {
    const profile = this.get(id)
    if (!profile) return null
    const rejected = { ...profile, state: 'rejected', rejectedAt: new Date().toISOString() }
    this.upsert(rejected)
    if (this.state.activeProfileId === id) this.state.activeProfileId = null
    this.save()
    return rejected
  }

  delete (id) {
    const before = this.state.profiles.length
    this.state.profiles = this.state.profiles.filter(profile => profile.id !== id)
    if (this.state.activeProfileId === id) this.state.activeProfileId = null
    this.save()
    return this.state.profiles.length !== before
  }

  active () {
    if (!this.state.activeProfileId) return null
    return this.get(this.state.activeProfileId)
  }
}

function createProfileStore (app, pluginId) {
  let root
  if (app && typeof app.getDataDirPath === 'function') {
    root = app.getDataDirPath()
  } else if (app && app.config && app.config.configPath) {
    root = app.config.configPath
  } else {
    root = path.join(process.cwd(), 'data')
  }
  return new ProfileStore(path.join(root, pluginId, 'profiles.json'))
}

module.exports = {
  ProfileStore,
  createProfileStore
}
