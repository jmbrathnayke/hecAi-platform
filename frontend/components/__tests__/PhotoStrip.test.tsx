import { render, screen } from "@testing-library/react";
import { PhotoStrip } from "@/components/PhotoStrip";

describe("PhotoStrip", () => {
  it("renders nothing before the first photo, rather than an empty labelled list", () => {
    const { container } = render(
      <PhotoStrip thumbnails={[]} countLabel="0 photos captured" ariaLabel="Photos" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("lists every thumbnail under the count line", () => {
    render(
      <PhotoStrip
        thumbnails={["blob:a", "blob:b", "blob:c"]}
        countLabel="3 photos captured"
        ariaLabel="Photos in this case"
      />,
    );
    expect(screen.getByText("3 photos captured")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Photos in this case" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("rings the newest photo — it is the subject of the result card below", () => {
    const { container } = render(
      <PhotoStrip thumbnails={["blob:a", "blob:b"]} countLabel="2" ariaLabel="Photos" />,
    );
    const images = Array.from(container.querySelectorAll("img"));
    expect(images[0].className).toContain("border-border-default");
    expect(images[1].className).toContain("border-forest");
  });

  it("leaves the thumbnails out of the accessibility tree — they carry no information", () => {
    const { container } = render(
      <PhotoStrip thumbnails={["blob:a"]} countLabel="1" ariaLabel="Photos" />,
    );
    expect(container.querySelector("img")).toHaveAttribute("alt", "");
  });
});
