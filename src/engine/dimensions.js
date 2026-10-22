// Dimension management for rows and columns supporting dynamic sizing,
// prefix sums, binary search for coordinate lookups, and structural shifts.
// Pure logic: zero React or DOM dependencies.

export function createDimensionManager(initialCount, defaultSize, minSize = 20) {
    let count = initialCount
    // Sparse map for non-default sizes: index -> size
    const customSizes = new Map()

    // Prefix sum array: prefixSums[i] is the offset of item i.
    // Length is count + 1, where prefixSums[count] is the total size.
    let prefixSums = null
    let dirty = true

    function rebuildPrefixSums() {
        if (!dirty && prefixSums && prefixSums.length === count + 1) return
        prefixSums = new Float64Array(count + 1)
        let total = 0
        for (let i = 0; i < count; i++) {
            prefixSums[i] = total
            const size = customSizes.get(i) ?? defaultSize
            total += size
        }
        prefixSums[count] = total
        dirty = false
    }

    function getSize(index) {
        if (index < 0 || index >= count) return defaultSize
        return customSizes.get(index) ?? defaultSize
    }

    function setSize(index, size) {
        if (index < 0 || index >= count) return
        const clampedSize = Math.max(minSize, Math.round(size))
        if (clampedSize === defaultSize) {
            if (customSizes.has(index)) {
                customSizes.delete(index)
                dirty = true
            }
        } else {
            if (customSizes.get(index) !== clampedSize) {
                customSizes.set(index, clampedSize)
                dirty = true
            }
        }
    }

    function getOffset(index) {
        if (index <= 0) return 0
        if (index >= count) {
            rebuildPrefixSums()
            return prefixSums[count]
        }
        rebuildPrefixSums()
        return prefixSums[index]
    }

    function getTotalSize() {
        rebuildPrefixSums()
        return prefixSums[count]
    }

    /**
     * Binary search to find the item index at a given pixel offset.
     * Returns the index `i` such that `offset >= getOffset(i) && offset < getOffset(i+1)`.
     */
    function findIndexAtOffset(offset) {
        if (offset <= 0) return 0
        rebuildPrefixSums()
        const total = prefixSums[count]
        if (offset >= total) return Math.max(0, count - 1)

        let low = 0
        let high = count - 1
        let result = 0

        while (low <= high) {
            const mid = (low + high) >> 1
            if (prefixSums[mid] <= offset) {
                result = mid
                low = mid + 1
            } else {
                high = mid - 1
            }
        }
        return Math.min(count - 1, Math.max(0, result))
    }

    /**
     * Get visible range [startIndex, endIndex] spanning [startOffset, endOffset].
     * Includes overscan indices before and after.
     */
    function getVisibleRange(startOffset, endOffset, overscan = 3) {
        rebuildPrefixSums()
        const rawStart = findIndexAtOffset(startOffset)
        const rawEnd = findIndexAtOffset(endOffset)

        const startIndex = Math.max(0, rawStart - overscan)
        const endIndex = Math.min(count - 1, rawEnd + overscan)

        return { startIndex, endIndex, rawStart, rawEnd }
    }

    function insertAt(atIndex, size = defaultSize) {
        const nextCustom = new Map()
        for (const [idx, sz] of customSizes.entries()) {
            if (idx >= atIndex) {
                nextCustom.set(idx + 1, sz)
            } else {
                nextCustom.set(idx, sz)
            }
        }
        if (size !== defaultSize) {
            nextCustom.set(atIndex, Math.max(minSize, Math.round(size)))
        }
        customSizes.clear()
        for (const [k, v] of nextCustom.entries()) {
            customSizes.set(k, v)
        }
        count++
        dirty = true
    }

    function deleteAt(atIndex) {
        if (count <= 1 || atIndex < 0 || atIndex >= count) return
        const nextCustom = new Map()
        for (const [idx, sz] of customSizes.entries()) {
            if (idx === atIndex) continue
            if (idx > atIndex) {
                nextCustom.set(idx - 1, sz)
            } else {
                nextCustom.set(idx, sz)
            }
        }
        customSizes.clear()
        for (const [k, v] of nextCustom.entries()) {
            customSizes.set(k, v)
        }
        count--
        dirty = true
    }

    function ensureCount(minCount) {
        if (minCount > count) {
            count = minCount
            dirty = true
        }
    }

    function snapshot() {
        return {
            count,
            customSizes: new Map(customSizes)
        }
    }

    function restore(snap) {
        count = snap.count
        customSizes.clear()
        for (const [k, v] of snap.customSizes.entries()) {
            customSizes.set(k, v)
        }
        dirty = true
    }

    return {
        get count() { return count },
        defaultSize,
        minSize,
        getSize,
        setSize,
        getOffset,
        getTotalSize,
        findIndexAtOffset,
        getVisibleRange,
        insertAt,
        deleteAt,
        ensureCount,
        snapshot,
        restore
    }
}
