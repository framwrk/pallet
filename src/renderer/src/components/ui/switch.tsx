import { Switch as SwitchPrimitive } from "@base-ui/react/switch"

import { cn } from "@renderer/lib/utils"

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full bg-foreground/15 p-[2px] transition-colors duration-150 ease-out outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-checked:bg-primary",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="size-[14px] rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.3)] transition-transform duration-150 ease-out data-checked:translate-x-3"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
