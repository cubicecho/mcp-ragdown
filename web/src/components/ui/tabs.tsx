import { Tabs as TabsPrimitive } from "radix-ui";
import type * as React from "react";
import {
  TABS_LIST_CLASS,
  TABS_TRIGGER_CLASS,
  TABS_TRIGGER_TEXT_CLASS,
  type TabsContentProps,
  type TabsListProps,
  type TabsProps,
  type TabsTriggerProps,
} from "@/components/ui/tabs-base";
import { cn } from "@/lib/utils";

/** The shared contract, widened to what the radix part underneath accepts. */
type Wide<Base, Radix> = Base & Omit<Radix, keyof Base>;

function Tabs({
  value,
  onValueChange,
  defaultValue,
  className,
  ...props
}: Wide<TabsProps, React.ComponentProps<typeof TabsPrimitive.Root>>) {
  // Spread only when given, so an absent `value` leaves radix uncontrolled.
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn(className)}
      {...props}
      {...(value === undefined ? {} : { value })}
      {...(onValueChange === undefined ? {} : { onValueChange })}
      {...(defaultValue === undefined ? {} : { defaultValue })}
    />
  );
}

function TabsList({
  className,
  ...props
}: Wide<TabsListProps, React.ComponentProps<typeof TabsPrimitive.List>>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn("inline-flex text-muted-foreground", TABS_LIST_CLASS, className)}
      {...props}
    />
  );
}

function TabsTrigger({
  className,
  disabled,
  ...props
}: Wide<TabsTriggerProps, React.ComponentProps<typeof TabsPrimitive.Trigger>>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      {...(disabled === undefined ? {} : { disabled })}
      // An icon child takes the trigger's colour through `currentColor`, so only
      // its size is set here; device has no inheritance and uses a context.
      className={cn(
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "inline-flex whitespace-nowrap ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm",
        TABS_TRIGGER_CLASS,
        TABS_TRIGGER_TEXT_CLASS,
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({
  className,
  ...props
}: Wide<TabsContentProps, React.ComponentProps<typeof TabsPrimitive.Content>>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn(
        "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        className,
      )}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
