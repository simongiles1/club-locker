import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BookingPage } from "./BookingPage.js";

describe("BookingPage", () => {
  it("renders court booking workflow", () => {
    const html = renderToStaticMarkup(
      <BookingPage seasonId="season-1" onLog={() => {}} />,
    );
    expect(html).toContain("First Monday of season");
    expect(html).toContain("Refresh preview");
    expect(html).toContain("Run season block (bulk)");
    expect(html).toContain("Court booking: season block");
  });
});
