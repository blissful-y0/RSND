<script lang="ts">
    import SegmentedControl from "src/lib/UI/GUI/SegmentedControl.svelte";
    import type { LLMModel } from "src/ts/model/types";
    import {
        geminiThinkingLevelToTokens,
        geminiThinkingTokensToLevel,
        isGeminiThinkingLevelModel,
        supportsGeminiMediumThinking,
        supportsGeminiMinimalThinking,
        type GeminiThinkingLevel,
    } from "src/ts/model/geminiThinking";
    import type { SeparateParameters } from "src/ts/storage/database.svelte";

    let {
        value = $bindable(),
        modelInfo,
        label = "Submodel Thinking",
        onChange,
    }: {
        value: SeparateParameters
        modelInfo?: LLMModel
        label?: string
        onChange?: () => void
    } = $props()

    const modelCtx = $derived(modelInfo ? { modelInfo } : null)
    const enabled = $derived(modelCtx ? isGeminiThinkingLevelModel(modelCtx) : false)
    const options = $derived([
        ...(modelCtx && supportsGeminiMinimalThinking(modelCtx) ? [{ value: 'minimal', label: 'Minimal' }] : []),
        { value: 'low', label: 'Low' },
        ...(modelCtx && supportsGeminiMediumThinking(modelCtx) ? [{ value: 'medium', label: 'Medium' }] : []),
        { value: 'high', label: 'High' },
    ])
    let thinkingLevel: GeminiThinkingLevel = $state('low')

    $effect(() => {
        if (!modelCtx) return
        thinkingLevel = geminiThinkingTokensToLevel(value.thinking_tokens, modelCtx)
    })

    function setThinkingLevel(level: string | number) {
        if (!enabled || typeof level !== 'string') return
        thinkingLevel = level as GeminiThinkingLevel
        const tokens = geminiThinkingLevelToTokens(thinkingLevel)
        if (value.thinking_tokens !== tokens) {
            value.thinking_tokens = tokens
            onChange?.()
        }
    }
</script>

{#if enabled}
    <span class="text-textcolor">{label}</span>
    <SegmentedControl
        className="mt-2"
        bind:value={thinkingLevel}
        {options}
        size="sm"
        fullWidth
        onChange={setThinkingLevel}
    />
{/if}
