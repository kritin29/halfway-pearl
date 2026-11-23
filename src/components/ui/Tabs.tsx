import { Tabs as TabsPrimitive } from '@base-ui/react/tabs'

import { cn } from '@/lib/utils'

function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn('flex flex-col gap-2', className)} {...props} />
}

/**
 * A segmented control. The white "selected" pill is Base UI's Tabs.Indicator,
 * so it slides from the old tab to the new one instead of blinking across.
 * Pass `indicatorClassName` to recolor it (the trip page tints it per section).
 */
function TabsList({
  className,
  children,
  indicatorClassName,
  ...props
}: TabsPrimitive.List.Props & { indicatorClassName?: string }) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        'relative z-0 inline-flex h-10 w-fit items-center justify-center rounded-xl bg-muted p-1 text-muted-foreground ring-1 ring-inset ring-border',
        className,
      )}
      {...props}
    >
      {children}
      <TabsPrimitive.Indicator
        data-slot="tabs-indicator"
        className={cn(
          'absolute -z-10 left-[var(--active-tab-left)] top-[var(--active-tab-top)] h-[var(--active-tab-height)] w-[var(--active-tab-width)] rounded-lg bg-card shadow-[0_1px_2px_rgba(28,39,51,0.08),0_4px_10px_-4px_rgba(28,39,51,0.18)] motion-safe:transition-[left,top,width,height,background-color] motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.2,0.8,0.2,1)]',
          indicatorClassName,
        )}
      />
    </TabsPrimitive.List>
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex h-full flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-3 py-1 text-sm font-semibold whitespace-nowrap text-muted-foreground transition-colors duration-150 outline-none hover:bg-card/50 hover:text-foreground data-[active]:text-accent-foreground data-[active]:hover:bg-transparent focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel data-slot="tabs-content" className={cn('enter-panel flex-1 outline-none', className)} {...props} />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
