<script lang="ts">
    import Help from "./Help.svelte";
    import { language } from "src/lang";
    import SliderInput from "../UI/GUI/SliderInput.svelte";
    import ClaudeThinkingSeparateParams from "../Setting/Pages/ClaudeThinkingSeparateParams.svelte";
    import GeminiThinkingSeparateParams from "../Setting/Pages/GeminiThinkingSeparateParams.svelte";
    import type { SeparateParameters } from "src/ts/storage/database.svelte";
    import type { LLMModel } from "src/ts/model/types";
    import { downloadFile } from "src/ts/globalApi.svelte";
    import { FileDownIcon, FileUpIcon } from "@lucide/svelte";
    import { selectSingleFile } from "src/ts/util";
    import SegmentedControl from "../UI/GUI/SegmentedControl.svelte";
    import {
        dbReasoningEffortToUi,
        dbVerbosityToUi,
        reasoningEffortSelectOptionsWithDefault,
        uiReasoningEffortToDb,
        uiVerbosityToDb,
        verbositySelectOptionsWithDefault,
        type ReasoningEffortUiValue,
        type VerbosityUiValue,
    } from "src/ts/model/reasoningVerbosity";


    let {
        value = $bindable(),
        withImportExport = false,
        modelInfo,
        showAuxControls = false,
    }:{
        value: SeparateParameters
        withImportExport?: boolean
        modelInfo?: LLMModel
        showAuxControls?: boolean
    } = $props()

    let reasoningEffortValue: ReasoningEffortUiValue = $state(
        dbReasoningEffortToUi(value.reasoning_effort, { allowDefault: true })
    )
    let verbosityValue: VerbosityUiValue = $state(
        dbVerbosityToUi(value.verbosity, { allowDefault: true })
    )

    $effect(() => {
        reasoningEffortValue = dbReasoningEffortToUi(value.reasoning_effort, { allowDefault: true })
    })

    $effect(() => {
        verbosityValue = dbVerbosityToUi(value.verbosity, { allowDefault: true })
    })

    $effect(() => {
        const mapped = uiReasoningEffortToDb(reasoningEffortValue)
        if (value.reasoning_effort !== mapped) {
            value.reasoning_effort = mapped
        }
    })

    $effect(() => {
        const mapped = uiVerbosityToDb(verbosityValue)
        if (value.verbosity !== mapped) {
            value.verbosity = mapped
        }
    })
</script>

{#if showAuxControls}
    <span class="text-textcolor">Max Response Tokens</span>
    <SliderInput className="mt-2" min={1} max={64000} marginBottom step={50} fixed={0} bind:value={value.maxResponse} disableable/>
    <GeminiThinkingSeparateParams bind:value={value} {modelInfo} />
{/if}
<span class="text-textcolor">{language.temperature} <Help key="tempature"/></span>
<SliderInput className="mt-2" min={0} max={200} marginBottom bind:value={value.temperature} multiple={0.01} fixed={2} disableable/>
<span class="text-textcolor">Top K</span>
<SliderInput className="mt-2" min={0} max={100} marginBottom step={1} bind:value={value.top_k} disableable/>
<span class="text-textcolor">{'Repetition Penalty'}</span>
<SliderInput className="mt-2" min={0} max={2} marginBottom step={0.01} fixed={2} bind:value={value.repetition_penalty} disableable/>
<span class="text-textcolor">Min P</span>
<SliderInput className="mt-2" min={0} max={1} marginBottom step={0.01} fixed={2} bind:value={value.min_p} disableable/>
<span class="text-textcolor">Top A</span>
<SliderInput className="mt-2" min={0} max={1} marginBottom step={0.01} fixed={2} bind:value={value.top_a} disableable/>
<span class="text-textcolor">Top P</span>
<SliderInput className="mt-2" min={0} max={1} marginBottom step={0.01} fixed={2} bind:value={value.top_p} disableable/>
<span class="text-textcolor">{language.frequencyPenalty}</span>
<SliderInput className="mt-2" min={0} max={200} marginBottom step={0.01} fixed={2} bind:value={value.frequency_penalty} disableable/>
<span class="text-textcolor">{language.presensePenalty}</span>
<SliderInput className="mt-2" min={0} max={200} marginBottom step={0.01} fixed={2} bind:value={value.presence_penalty} disableable/>
<span class="text-textcolor">Reasoning Effort</span>
<SegmentedControl
    bind:value={reasoningEffortValue}
    options={reasoningEffortSelectOptionsWithDefault}
    size="sm"
    wrap
    fullWidth
/>
<ClaudeThinkingSeparateParams bind:value={value} />
<span class="text-textcolor">{'Verbosity'}</span>
<SegmentedControl
    bind:value={verbosityValue}
    options={verbositySelectOptionsWithDefault}
    size="sm"
    fullWidth
/>

{#if withImportExport}
    <div class="flex">
        <button class="bg-primary hover:bg-primary/90 text-white font-bold py-2 px-4 rounded" onclick={() => {
            const json = JSON.stringify(value, null, 2)
            downloadFile(`parameters-${Date.now()}.json`, json)
        }}>
            <FileDownIcon />
        </button>
        <button class="bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded ml-2" onclick={async () => {
            const file = await selectSingleFile(['json'])
            const fileText = await (new TextDecoder()).decode(file.data)
            try {
                const json = JSON.parse(fileText)

                value = json
            } catch (e) {
                alert(language.noData)
            }
        }}>
            <FileUpIcon />
        </button>
    </div>
{/if}
