/**
 * Small bounded scheduler used by the core lifecycle batch operation.
 *
 * The scheduler deliberately knows nothing about HTTP or business decisions. It
 * only owns resource limits: global active work, active institutions, one task
 * per origin/institution, origin delay and Retry-After backoff. Results are
 * returned in input order so completion order cannot become decision state.
 */
export class OriginScheduler {
    constructor({
        maxActive = 24,
        maxActiveInstitutions = 24,
        maxInFlightPerOrigin = 1,
        maxInFlightPerInstitution = 1,
        originDelayMs = 0,
        retryAfterCapMs = 60_000,
        sleep = defaultSleep,
        now = () => Date.now()
    } = {}) {
        this.maxActive = positiveLimit(maxActive, "maxActive");
        this.maxActiveInstitutions = positiveLimit(maxActiveInstitutions, "maxActiveInstitutions");
        this.maxInFlightPerOrigin = positiveLimit(maxInFlightPerOrigin, "maxInFlightPerOrigin");
        this.maxInFlightPerInstitution = positiveLimit(maxInFlightPerInstitution, "maxInFlightPerInstitution");
        this.originDelayMs = nonNegativeLimit(originDelayMs, "originDelayMs");
        this.retryAfterCapMs = nonNegativeLimit(retryAfterCapMs, "retryAfterCapMs");
        this.sleep = sleep;
        this.now = now;
    }

    /**
     * @param {Array<object>} tasks
     * @param {(task: object) => Promise<object>|object} worker
     * @returns {Promise<Array<{task: object, result: object}>>}
     */
    async run(tasks, worker) {
        if (!Array.isArray(tasks)) {
            throw new TypeError("scheduler tasks must be an array");
        }
        if (typeof worker !== "function") {
            throw new TypeError("scheduler worker must be a function");
        }
        const pending = tasks.map((task, index) => ({task, index}));
        const results = new Array(pending.length);
        const active = new Set();
        const originActive = new Map();
        const institutionActive = new Map();
        const originReadyAt = new Map();

        while (pending.length > 0 || active.size > 0) {
            let launched = false;
            while (pending.length > 0 && active.size < this.maxActive) {
                const selectedIndex = this.findEligibleIndex(
                    pending,
                    active,
                    originActive,
                    institutionActive,
                    originReadyAt
                );
                if (selectedIndex < 0) {
                    break;
                }
                const [item] = pending.splice(selectedIndex, 1);
                const origin = taskKey(item.task, "origin");
                const institution = taskKey(item.task, "institution_id", origin);
                increment(originActive, origin);
                increment(institutionActive, institution);
                const promise = Promise.resolve()
                    .then(() => worker(item.task))
                    .then((result) => {
                        const retryAfter = Number(result?.retryAfterMs ?? 0);
                        const delay = Math.max(this.originDelayMs, boundedDelay(retryAfter, this.retryAfterCapMs));
                        originReadyAt.set(origin, this.now() + delay);
                        results[item.index] = {task: item.task, result: result ?? {}};
                    })
                    .finally(() => {
                        decrement(originActive, origin);
                        decrement(institutionActive, institution);
                        active.delete(promise);
                    });
                active.add(promise);
                launched = true;
            }

            if (active.size > 0) {
                await Promise.race(active);
                continue;
            }
            if (pending.length > 0) {
                const waitMs = this.nextWaitMs(pending, originReadyAt);
                await this.sleep(waitMs);
            }
        }
        return results;
    }

    findEligibleIndex(pending, active, originActive, institutionActive, originReadyAt) {
        const now = this.now();
        for (let index = 0; index < pending.length; index += 1) {
            const task = pending[index].task;
            const origin = taskKey(task, "origin");
            const institution = taskKey(task, "institution_id", origin);
            if ((originActive.get(origin) ?? 0) >= this.maxInFlightPerOrigin) {
                continue;
            }
            if ((institutionActive.get(institution) ?? 0) >= this.maxInFlightPerInstitution) {
                continue;
            }
            const activeInstitutions = institutionActive.size;
            if (!institutionActive.has(institution) && activeInstitutions >= this.maxActiveInstitutions) {
                continue;
            }
            if ((originReadyAt.get(origin) ?? 0) > now) {
                continue;
            }
            return index;
        }
        return -1;
    }

    nextWaitMs(pending, originReadyAt) {
        const now = this.now();
        let next = 10;
        for (const item of pending) {
            const origin = taskKey(item.task, "origin");
            const readyAt = originReadyAt.get(origin) ?? now;
            if (readyAt > now) {
                next = Math.max(1, Math.min(next === 10 ? readyAt - now : next, readyAt - now));
            }
        }
        return next;
    }
}

function taskKey(task, field, fallback = "default") {
    const value = task?.[field];
    if (typeof value !== "string" || value.trim().length === 0) return fallback;
    return field === "origin" ? value.trim().toLowerCase() : value;
}

function increment(map, key) {
    map.set(key, (map.get(key) ?? 0) + 1);
}

function decrement(map, key) {
    const next = (map.get(key) ?? 1) - 1;
    if (next <= 0) {
        map.delete(key);
    } else {
        map.set(key, next);
    }
}

function boundedDelay(value, cap) {
    if (!Number.isFinite(value) || value <= 0) {
        return 0;
    }
    return Math.min(Math.floor(value), cap);
}

function positiveLimit(value, name) {
    if (!Number.isInteger(value) || value < 1) {
        throw new TypeError(`${name} must be a positive integer`);
    }
    return value;
}

function nonNegativeLimit(value, name) {
    if (!Number.isInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative integer`);
    }
    return value;
}

function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
