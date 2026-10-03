import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { measureReflow } from '../apps/web/e2e/utils/design-acceptance'

type Rectangle = { left: number; top: number; width: number; height: number }

interface FixtureElement {
  localName: string
  rectangle: Rectangle
  properties: Record<string, string>
  style: Record<
    | 'visibility'
    | 'display'
    | 'contentVisibility'
    | 'opacity'
    | 'position'
    | 'clip'
    | 'clipPath'
    | 'maskImage'
    | 'transform'
    | 'overflowX'
    | 'overflowY',
    string
  > & {
    getPropertyValue: (property: string) => string
  }
  parentElement: FixtureElement | null
  children: FixtureElement[]
  clientLeft: number
  clientTop: number
  clientWidth: number
  clientHeight: number
  scrollWidth: number
  shadowRoot: null
  textContent: string
  getBoundingClientRect: Mock<() => Rectangle & { right: number; bottom: number }>
  hasAttribute: () => boolean
  getAttribute: () => null
  closest: () => null
  matches: (selector: string) => boolean
  querySelectorAll: Mock<(selector: string) => FixtureElement[]>
}

function fixture(rectangle: Rectangle, localName = 'div'): FixtureElement {
  const properties: Record<string, string> = {
    zoom: '1',
    scale: 'none',
    rotate: 'none',
    translate: 'none',
    perspective: 'none',
  }
  const style = {
    visibility: 'visible',
    display: 'block',
    contentVisibility: 'visible',
    opacity: '1',
    position: 'static',
    clip: 'auto',
    clipPath: 'none',
    maskImage: 'none',
    transform: 'none',
    overflowX: 'visible',
    overflowY: 'visible',
    getPropertyValue: (property: string) => properties[property] ?? '',
  }
  return {
    localName,
    rectangle,
    style,
    properties,
    parentElement: null as FixtureElement | null,
    children: [] as FixtureElement[],
    clientLeft: 0,
    clientTop: 0,
    clientWidth: rectangle.width,
    clientHeight: rectangle.height,
    scrollWidth: rectangle.width,
    shadowRoot: null,
    textContent: 'Example control',
    getBoundingClientRect: vi.fn(() => ({
      ...rectangle,
      right: rectangle.left + rectangle.width,
      bottom: rectangle.top + rectangle.height,
    })),
    hasAttribute: () => false,
    getAttribute: () => null,
    closest: () => null,
    matches: (selector: string) =>
      localName === 'button' && selector.includes('button') && !selector.startsWith('iframe'),
    querySelectorAll: vi.fn((_selector: string): FixtureElement[] => []),
  }
}

function makeHarness() {
  const root = fixture({ left: 0, top: 0, width: 390, height: 1000 }, 'html')
  const body = fixture({ left: 0, top: 0, width: 390, height: 1000 }, 'body')
  const scope = fixture({ left: 10, top: 10, width: 300, height: 600 })
  const control = fixture({ left: 20, top: 20, width: 44, height: 44 }, 'button')
  body.parentElement = root
  scope.parentElement = body
  control.parentElement = scope
  root.children = [body]
  body.children = [scope]
  scope.children = [control]
  scope.querySelectorAll.mockReturnValue([control])
  const animations: Animation[] = []
  const document = {
    documentElement: root,
    body,
    querySelectorAll: vi.fn(() => [scope]),
    getAnimations: vi.fn(() => [...animations]),
  }
  const geometryTimes: number[] = []
  for (const element of [root, body, scope, control]) {
    element.getBoundingClientRect.mockImplementation(() => {
      geometryTimes.push(performance.now())
      return {
        ...element.rectangle,
        right: element.rectangle.left + element.rectangle.width,
        bottom: element.rectangle.top + element.rectangle.height,
      }
    })
  }
  const requestFrame = vi.fn((callback: (time: number) => void) =>
    Number(setTimeout(() => callback(performance.now()), 16))
  )
  const cancelFrame = vi.fn((handle: number) => clearTimeout(handle))
  const observationNow = vi.fn(() => performance.now())
  const evaluate = vi.fn(async (callback: (argument: unknown) => unknown, argument: unknown) => {
    // Recreate the shipped callback rather than call its original closure.
    // An accidental reference to an outer helper fails in this isolated realm.
    const isolated = runInNewContext('(' + callback.toString() + ')', {
      document,
      getComputedStyle: (element: FixtureElement) => element.style,
      location: { href: 'https://acme.example/' },
      innerWidth: 390,
      innerHeight: 1000,
      visualViewport: { scale: 1 },
      devicePixelRatio: 1,
      matchMedia: () => ({ matches: false }),
      performance: { now: observationNow },
      setTimeout,
      clearTimeout,
      requestAnimationFrame: requestFrame,
      cancelAnimationFrame: cancelFrame,
    }) as (argument: unknown) => ReturnType<typeof measureReflow>
    return isolated(argument)
  })
  const page = { evaluate } as unknown as Parameters<typeof measureReflow>[0]
  return {
    root,
    body,
    scope,
    control,
    animations,
    document,
    geometryTimes,
    observationNow,
    requestFrame,
    cancelFrame,
    evaluate,
    page,
  }
}

function animation(endTime = 300) {
  let resolve!: () => void
  let reject!: (reason: unknown) => void
  const finished = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  const observed = {
    playState: 'running',
    pending: false,
    effect: { getComputedTiming: vi.fn(() => ({ endTime })) },
    finished,
    cancel: vi.fn(),
    finish: vi.fn(),
    pause: vi.fn(),
  }
  return {
    observed: observed as unknown as Animation,
    model: observed,
    complete: () => {
      observed.playState = 'finished'
      observed.pending = false
      resolve()
    },
    reject,
  }
}

function measure(harness: ReturnType<typeof makeHarness>) {
  return measureReflow(harness.page, [{ selector: '#scope', expectInteractive: true }], {
    artifactRevision: 'unit-observation',
    state: 'animation-readiness',
  })
}

function unchanged(animationModel: ReturnType<typeof animation>) {
  expect(animationModel.model.cancel).not.toHaveBeenCalled()
  expect(animationModel.model.finish).not.toHaveBeenCalled()
  expect(animationModel.model.pause).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('reflow animation readiness in the serialized geometry callback', () => {
  it('crosses a frame and task before accepting an initially quiet document', async () => {
    const harness = makeHarness()
    const pending = measure(harness)
    expect(harness.geometryTimes).toEqual([])
    await vi.runAllTimersAsync()
    const result = await pending
    expect(result.animationReadiness).toMatchObject({
      status: 'settled',
      timeoutMs: 5000,
      scans: 2,
      finiteAnimations: 0,
      reason: null,
    })
    expect(harness.requestFrame).toHaveBeenCalledTimes(1)
    expect(harness.geometryTimes[0]).toBeGreaterThanOrEqual(16)
    expect(harness.evaluate).toHaveBeenCalledTimes(1)
    expect(result.issues).toEqual([])
  })

  it.each(['running', 'pending'])(
    'waits for a finite %s animation before reading geometry',
    async (state) => {
      const harness = makeHarness()
      const current = animation()
      if (state === 'pending') {
        current.model.playState = 'idle'
        current.model.pending = true
      }
      harness.animations.push(current.observed)
      setTimeout(current.complete, 120)
      const pending = measure(harness)
      await vi.advanceTimersByTimeAsync(119)
      expect(harness.geometryTimes).toEqual([])
      await vi.runAllTimersAsync()
      const result = await pending
      expect(result.animationReadiness).toMatchObject({ status: 'settled', finiteAnimations: 1 })
      expect(harness.geometryTimes[0]).toBeGreaterThan(120)
      expect(result.issues).toEqual([])
      unchanged(current)
    }
  )

  it('catches an animation introduced by a later callback in the same frame', async () => {
    const harness = makeHarness()
    const current = animation()
    let introduced = false
    harness.requestFrame.mockImplementation((callback) => {
      const handle = setTimeout(() => callback(performance.now()), 16)
      // Distinct callbacks at the same frame time allow a microtask checkpoint
      // after our callback, before the later callback introduces its animation.
      setTimeout(() => {
        if (introduced) return
        introduced = true
        harness.animations.push(current.observed)
        setTimeout(current.complete, 80)
      }, 16)
      return Number(handle)
    })
    const pending = measure(harness)
    await vi.advanceTimersByTimeAsync(90)
    expect(harness.geometryTimes).toEqual([])
    await vi.runAllTimersAsync()
    const result = await pending
    expect(result.animationReadiness.finiteAnimations).toBe(1)
    expect(harness.geometryTimes[0]).toBeGreaterThan(96)
    expect(result.issues).toEqual([])
    unchanged(current)
  })

  it('waits for a newly chained finite animation', async () => {
    const harness = makeHarness()
    const first = animation()
    const next = animation()
    harness.animations.push(first.observed)
    setTimeout(() => {
      first.complete()
      harness.animations.push(next.observed)
    }, 40)
    setTimeout(next.complete, 140)
    const pending = measure(harness)
    await vi.advanceTimersByTimeAsync(139)
    expect(harness.geometryTimes).toEqual([])
    await vi.runAllTimersAsync()
    const result = await pending
    expect(result.animationReadiness.finiteAnimations).toBe(2)
    expect(result.issues).toEqual([])
    unchanged(first)
    unchanged(next)
  })

  it('waits for a restarted object with a new finished promise', async () => {
    const harness = makeHarness()
    const first = animation()
    const restarted = animation()
    harness.animations.push(first.observed)
    setTimeout(() => {
      first.complete()
      first.model.playState = 'running'
      first.model.finished = restarted.model.finished
    }, 40)
    setTimeout(() => {
      first.model.playState = 'finished'
      restarted.complete()
    }, 140)
    const pending = measure(harness)
    await vi.advanceTimersByTimeAsync(139)
    expect(harness.geometryTimes).toEqual([])
    await vi.runAllTimersAsync()
    const result = await pending
    expect(result.animationReadiness.finiteAnimations).toBe(1)
    expect(result.issues).toEqual([])
    unchanged(first)
  })

  it('handles the retained 66–80ms route-wait gap without waiving the identity matrix', async () => {
    const harness = makeHarness()
    const panel = animation()
    // The earlier route-level snapshot is empty. Hydration introduces the panel
    // before the later geometry call, as in the retained PR221 failure timing.
    expect(harness.document.getAnimations()).toEqual([])
    setTimeout(() => {
      harness.animations.push(panel.observed)
      harness.scope.style.transform = 'matrix(1, 0, 0, 1, 0, 0)'
    }, 66)
    setTimeout(() => {
      panel.complete()
      harness.scope.style.transform = 'none'
    }, 366)
    await vi.advanceTimersByTimeAsync(80)
    const pending = measure(harness)
    await vi.advanceTimersByTimeAsync(285)
    expect(harness.geometryTimes).toEqual([])
    await vi.runAllTimersAsync()
    const result = await pending
    expect(result.animationReadiness.status).toBe('settled')
    expect(harness.geometryTimes[0]).toBeGreaterThan(366)
    expect(result.issues).toEqual([])
    unchanged(panel)
  })

  it('uses one deadline across animation batches', async () => {
    const harness = makeHarness()
    const first = animation()
    const neverFinishes = animation()
    harness.animations.push(first.observed)
    setTimeout(() => {
      first.complete()
      harness.animations.push(neverFinishes.observed)
    }, 3000)
    const pending = measure(harness)
    await vi.advanceTimersByTimeAsync(5001)
    const result = await pending
    expect(result.animationReadiness).toMatchObject({
      status: 'review-required',
      elapsedMs: 5000,
      finiteAnimations: 2,
    })
    expect(result.animationReadiness.reason).toContain('deadline-exceeded')
    expect(result.issues.map((issue) => issue.kind)).toEqual(['animation-readiness-unresolved'])
    expect(harness.geometryTimes[0]).toBe(5000)
    unchanged(first)
    unchanged(neverFinishes)
  })

  it('does not accept a final quiet scan that consumes the deadline', async () => {
    const harness = makeHarness()
    harness.document.getAnimations.mockReturnValueOnce([]).mockImplementationOnce(() => {
      harness.observationNow.mockReturnValue(5000)
      return []
    })
    const pending = measure(harness)
    await vi.runAllTimersAsync()
    const result = await pending
    expect(result.animationReadiness).toMatchObject({
      status: 'review-required',
      elapsedMs: 5000,
      scans: 2,
    })
    expect(result.animationReadiness.reason).toContain('deadline-exceeded')
    expect(result.issues.map((issue) => issue.kind)).toEqual(['animation-readiness-unresolved'])
    expect(harness.geometryTimes.length).toBeGreaterThan(0)
  })

  it('uses the same deadline when a rendering frame never arrives', async () => {
    const harness = makeHarness()
    harness.requestFrame.mockReturnValue(73)
    const pending = measure(harness)
    await vi.advanceTimersByTimeAsync(5001)
    const result = await pending
    expect(result.animationReadiness).toMatchObject({ status: 'review-required', elapsedMs: 5000 })
    expect(harness.cancelFrame).toHaveBeenCalledExactlyOnceWith(73)
    expect(result.issues.map((issue) => issue.kind)).toEqual(['animation-readiness-unresolved'])
  })

  it('retains a rejected finished promise as review-required', async () => {
    const harness = makeHarness()
    const current = animation()
    harness.animations.push(current.observed)
    setTimeout(() => current.reject(new Error('animation rejected')), 20)
    const pending = measure(harness)
    await vi.runAllTimersAsync()
    const result = await pending
    expect(result.animationReadiness.reason).toContain('animation rejected')
    expect(result.status).toBe('review-required')
    expect(harness.geometryTimes[0]).toBe(20)
    unchanged(current)
  })

  it('handles a finished rejection occurring after the timeout', async () => {
    const harness = makeHarness()
    const current = animation()
    harness.animations.push(current.observed)
    setTimeout(() => current.reject(new Error('late rejection')), 6000)
    const pending = measure(harness)
    await vi.advanceTimersByTimeAsync(5001)
    const result = await pending
    expect(result.animationReadiness.reason).toContain('deadline-exceeded')
    await vi.advanceTimersByTimeAsync(1000)
    expect(result.animationReadiness.status).toBe('review-required')
    unchanged(current)
  })

  it('handles an earlier promise rejection after a later observation fails', async () => {
    const harness = makeHarness()
    const first = animation()
    const invalid = animation()
    invalid.model.effect.getComputedTiming.mockImplementation(() => {
      throw new Error('later timing observation failed')
    })
    harness.animations.push(first.observed, invalid.observed)
    setTimeout(() => first.reject(new Error('earlier promise rejected later')), 20)
    const result = await measure(harness)
    expect(result.animationReadiness.reason).toContain('later timing observation failed')
    await vi.advanceTimersByTimeAsync(21)
    expect(result.animationReadiness.reason).toContain('later timing observation failed')
    expect(result.issues.map((issue) => issue.kind)).toEqual(['animation-readiness-unresolved'])
    unchanged(first)
    unchanged(invalid)
  })

  it.each(['enumeration', 'timing', 'missing timing', 'nonfinite timing', 'finished promise'])(
    'does not accept unsupported %s observations as quiet',
    async (fault) => {
      const harness = makeHarness()
      const current = animation()
      harness.animations.push(current.observed)
      if (fault === 'enumeration')
        harness.document.getAnimations.mockImplementation(() => {
          throw new Error('enumeration unavailable')
        })
      if (fault === 'timing')
        current.model.effect.getComputedTiming.mockImplementation(() => {
          throw new Error('timing unavailable')
        })
      if (fault === 'missing timing')
        current.model.effect = null as unknown as typeof current.model.effect
      if (fault === 'nonfinite timing')
        current.model.effect.getComputedTiming.mockReturnValue({ endTime: Number.NaN })
      if (fault === 'finished promise') current.model.finished = null as unknown as Promise<void>
      const pending = measure(harness)
      await vi.runAllTimersAsync()
      const result = await pending
      expect(result.status).toBe('review-required')
      expect(result.animationReadiness.reason).not.toBeNull()
      expect(result.issues.map((issue) => issue.kind)).toEqual(['animation-readiness-unresolved'])
      expect(harness.geometryTimes.length).toBeGreaterThan(0)
      unchanged(current)
    }
  )

  it('observes infinite animation without waiting or suppressing its transform finding', async () => {
    const harness = makeHarness()
    const infinite = animation(Infinity)
    harness.animations.push(infinite.observed)
    harness.scope.style.transform = 'matrix(0, 1, -1, 0, 0, 0)'
    const pending = measure(harness)
    await vi.runAllTimersAsync()
    const result = await pending
    expect(result.animationReadiness).toMatchObject({
      status: 'settled',
      finiteAnimations: 0,
      infiniteAnimations: 1,
    })
    expect(result.issues.map((issue) => issue.kind)).toContain(
      'transformed-coordinate-frame-needs-review'
    )
    unchanged(infinite)
  })

  it.each([
    ['identity matrix', 'matrix(1, 0, 0, 1, 0, 0)'],
    ['tiny translation', 'matrix(1, 0, 0, 1, 0.000001, 0)'],
    ['scale', 'matrix(0.99, 0, 0, 0.99, 0, 0)'],
    ['rotation', 'matrix(0, 1, -1, 0, 0, 0)'],
  ])('keeps the existing %s review after animation settling', async (_name, transform) => {
    const harness = makeHarness()
    harness.scope.style.transform = transform
    const pending = measure(harness)
    await vi.runAllTimersAsync()
    const result = await pending
    expect(result.animationReadiness.status).toBe('settled')
    expect(result.issues.map((issue) => issue.kind)).toEqual([
      'transformed-coordinate-frame-needs-review',
    ])
    expect(result.status).toBe('review-required')
  })

  it.each([
    ['scale', '1.01'],
    ['rotate', '1deg'],
    ['translate', '1px'],
    ['perspective', '100px'],
    ['zoom', '1.01'],
  ])('retains the existing individual %s check', async (property, value) => {
    const harness = makeHarness()
    harness.scope.properties[property] = value
    const pending = measure(harness)
    await vi.runAllTimersAsync()
    const result = await pending
    expect(result.issues.map((issue) => issue.kind)).toContain(
      'transformed-coordinate-frame-needs-review'
    )
  })

  it('keeps overflow, clipping and failure precedence when readiness fails', async () => {
    const harness = makeHarness()
    const current = animation()
    harness.animations.push(current.observed)
    harness.root.scrollWidth = 440
    harness.scope.style.clipPath = 'inset(10%)'
    harness.scope.style.overflowX = 'hidden'
    harness.control.rectangle.left = 380
    const pending = measure(harness)
    await vi.advanceTimersByTimeAsync(5001)
    const result = await pending
    expect(result.issues.map((issue) => issue.kind)).toEqual(
      expect.arrayContaining([
        'animation-readiness-unresolved',
        'horizontal-page-overflow',
        'clipped-or-masked-coordinate-frame-needs-review',
        'interactive-clipped-by-ancestor',
        'interactive-outside-horizontal-viewport',
      ])
    )
    expect(result.status).toBe('fail')
    unchanged(current)
  })
})
