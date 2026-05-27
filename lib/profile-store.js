'use strict'

const fs = require('fs')
const path = require('path')

class ProfileStore {
  constructor (filePath) {
    this.filePath = filePath
    this.state = {
      profiles: [],
      activeProfileId: null,
      activeInputSource: null,
      lastCalibrationReport: null
    }
  }

  load () {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      this.state = {
        profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
        activeProfileId: parsed.activeProfileId || null,
        activeInputSource: parsed.activeInputSource || null,
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

  saveProfile (profile) {
    const now = new Date().toISOString()
    const saved = {
      ...profile,
      state: 'saved',
      savedAt: profile.savedAt || now,
      displayName: profile.displayName || now.replace('T', ' ').slice(0, 19)
    }
    return this.upsert(saved)
  }

  activate (id) {
    const activated = this.get(id)
    if (!activated) return null
    this.state.activeProfileId = id
    this.save()
    return activated
  }

  configureRuntime (profileId, inputSource) {
    if (profileId && !this.get(profileId)) return null
    this.state.activeProfileId = profileId || null
    this.state.activeInputSource = inputSource || null
    this.save()
    return {
      activeProfileId: this.state.activeProfileId,
      activeInputSource: this.state.activeInputSource
    }
  }

  activeInputSource () {
    return this.state.activeInputSource || null
  }

  archive (id) {
    const profile = this.get(id)
    if (!profile) return null
    const archived = { ...profile, state: 'archived', archivedAt: new Date().toISOString() }
    this.upsert(archived)
    if (this.state.activeProfileId === id) {
      this.state.activeProfileId = null
      this.state.activeInputSource = null
    }
    this.save()
    return archived
  }

  reject (id) {
    const profile = this.get(id)
    if (!profile) return null
    const rejected = { ...profile, state: 'rejected', rejectedAt: new Date().toISOString() }
    this.upsert(rejected)
    if (this.state.activeProfileId === id) {
      this.state.activeProfileId = null
      this.state.activeInputSource = null
    }
    this.save()
    return rejected
  }

  delete (id) {
    const before = this.state.profiles.length
    this.state.profiles = this.state.profiles.filter(profile => profile.id !== id)
    if (this.state.activeProfileId === id) {
      this.state.activeProfileId = null
      this.state.activeInputSource = null
    }
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
  } else {
    root = path.join(process.cwd(), 'data')
  }
  return new ProfileStore(path.join(root, pluginId, 'profiles.json'))
}

module.exports = {
  ProfileStore,
  createProfileStore
}
