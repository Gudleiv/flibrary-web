<script setup lang="ts">
// Мини-флаг языка. Описание флага — в lib/flags.ts, здесь только отрисовка.

import { computed } from 'vue';

import { FLAG_VIEW_BOX, flagFor } from '@/lib/flags';
import { languageName } from '@/lib/lang';

const props = withDefaults(defineProps<{ code: string | null; width?: number }>(), { width: 18 });

const flag = computed(() => flagFor(props.code));

/** Флаг рядом с названием языка — украшение: подпись уже есть, дублировать её не нужно. */
const title = computed(() => languageName(props.code));

const WIDTH = 30;
const HEIGHT = 20;

/** Полосы в доли поля: без weights — поровну. */
function bands(colors: string[], weights: number[] | undefined, total: number) {
  const sizes = weights ?? colors.map(() => 1);
  const sum = sizes.reduce((accumulator, size) => accumulator + size, 0);

  let offset = 0;
  return colors.map((color, index) => {
    const size = ((sizes[index] ?? 1) / sum) * total;
    const start = offset;
    offset += size;
    // Полосы кладём внахлёст на полпикселя: иначе между ними просвечивает фон.
    return { color, start, size: size + 0.5 };
  });
}

const horizontal = computed(() =>
  flag.value?.kind === 'h' ? bands(flag.value.colors, flag.value.weights, HEIGHT) : [],
);

const vertical = computed(() =>
  flag.value?.kind === 'v' ? bands(flag.value.colors, flag.value.weights, WIDTH) : [],
);
</script>

<template>
  <svg
    class="flag-icon"
    :width="width"
    :height="Math.round((width * HEIGHT) / WIDTH)"
    :viewBox="FLAG_VIEW_BOX"
    role="img"
    :aria-label="title"
  >
    <title>{{ title }}</title>

    <template v-if="flag?.kind === 'h'">
      <rect
        v-for="band in horizontal"
        :key="band.start"
        :y="band.start"
        :width="WIDTH"
        :height="band.size"
        :fill="band.color"
      />
    </template>

    <template v-else-if="flag?.kind === 'v'">
      <rect
        v-for="band in vertical"
        :key="band.start"
        :x="band.start"
        :width="band.size"
        :height="HEIGHT"
        :fill="band.color"
      />
    </template>

    <template v-else-if="flag?.kind === 'nordic'">
      <rect :width="WIDTH" :height="HEIGHT" :fill="flag.field" />
      <!-- Крест смещён к древку: этим скандинавский флаг и опознаётся. -->
      <path d="M11,0 V20 M0,8 H30" :stroke="flag.cross" stroke-width="4" />
      <path v-if="flag.inner" d="M11,0 V20 M0,8 H30" :stroke="flag.inner" stroke-width="1.6" />
    </template>

    <template v-else-if="flag?.kind === 'disc'">
      <rect :width="WIDTH" :height="HEIGHT" :fill="flag.field" />
      <circle
        :cx="flag.cx ?? WIDTH / 2"
        :cy="flag.cy ?? HEIGHT / 2"
        :r="flag.r ?? 5"
        :fill="flag.disc"
      />
    </template>

    <!-- eslint-disable-next-line vue/no-v-html -- разметка своя, из lib/flags.ts -->
    <g v-else-if="flag?.kind === 'raw'" v-html="flag.content" />

    <!-- Языка без флага в коллекции хватает (например, 'mul'): глобус честнее пустоты,
         которая выглядела бы как не загрузившаяся картинка. -->
    <g v-else class="flag-icon__unknown">
      <rect :width="WIDTH" :height="HEIGHT" rx="2" fill="currentColor" opacity="0.08" />
      <circle cx="15" cy="10" r="6" fill="none" stroke="currentColor" stroke-width="1.1" />
      <path
        d="M9,10 H21 M15,4 a9,6 0 0 1 0,12 a9,6 0 0 1 0,-12"
        fill="none"
        stroke="currentColor"
        stroke-width="1.1"
      />
    </g>
  </svg>
</template>

<style scoped>
.flag-icon {
  flex: none;
  border-radius: 2px;
  /* Белые флаги на белом фоне иначе сливаются с карточкой. */
  box-shadow: 0 0 0 1px rgb(0 0 0 / 12%);
}

.flag-icon__unknown {
  color: var(--p-text-muted-color);
}
</style>
