// Adapted from shadcn/ui (MIT). See docs/UI_REFERENCES.md and third-party/shadcn-ui-LICENSE.md.
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";
const buttonVariants = cva(
  "inline-flex max-w-full min-w-0 min-h-11 items-center justify-center gap-2 rounded-sm border border-transparent px-4 py-2 text-base font-medium transition-colors disabled:pointer-events-none disabled:bg-muted disabled:text-muted-foreground",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary-hover hover:text-primary-hover-foreground",
        destructive: "bg-destructive text-destructive-foreground",
        outline: "border-input bg-card text-card-foreground",
        secondary: "bg-muted text-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);
function Button({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, className }))}
      {...props}
    />
  );
}
export { Button, buttonVariants };
