import { fireEvent, render, screen } from "@testing-library/react";
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

  it("offers no remove buttons unless the screen asks for them", () => {
    render(<PhotoStrip thumbnails={["blob:a"]} countLabel="1" ariaLabel="Photos" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("removes the photo whose button was pressed (an accidental frame can be taken out)", () => {
    const onRemove = jest.fn();
    render(
      <PhotoStrip
        thumbnails={["blob:a", "blob:b"]}
        countLabel="2"
        ariaLabel="Photos"
        onRemove={onRemove}
        removeLabel={(n) => `Remove photo ${n}`}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove photo 2" }));
    expect(onRemove).toHaveBeenCalledWith(1);
  });

  it("disables removal while a classification is running", () => {
    render(<PhotoStrip thumbnails={["blob:a"]} countLabel="1" ariaLabel="Photos" onRemove={jest.fn()} removeDisabled />);
    expect(screen.getByRole("button", { name: "Remove photo 1" })).toBeDisabled();
  });

  it("keeps a tile for a photo whose preview could not be made, so it can still be removed", () => {
    const { container } = render(
      <PhotoStrip thumbnails={["", "blob:b"]} countLabel="2" ariaLabel="Photos" onRemove={jest.fn()} />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Remove photo 1" })).toBeInTheDocument();
  });
});
