import { useExternalLinkOpener } from "@rakazo/chat-ui/web";
import type { LinkButton } from "@rakazo/contracts";
import { buttonVariants } from "@rakazo/ui-web";

/** A bot post's link buttons. A web page opens as a chat link does; an app link hands off. */
export function LinkButtons({ buttons }: { buttons: LinkButton[] }) {
  const { open, dialog } = useExternalLinkOpener();
  return (
    <div className="flex flex-wrap gap-2">
      {buttons.map((button, index) => (
        <a
          key={`${index}:${button.url}`}
          href={button.url}
          onClick={(event) => {
            if (!button.url.startsWith("https:")) return;
            event.preventDefault();
            open(button.url);
          }}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          {button.label}
        </a>
      ))}
      {dialog}
    </div>
  );
}
