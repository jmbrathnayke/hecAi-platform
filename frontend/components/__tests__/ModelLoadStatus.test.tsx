import { act, render, screen, waitFor } from "@testing-library/react";
import { ModelLoadStatus } from "@/components/ModelLoadStatus";
import { loadModel } from "@/lib/mobilenet";

jest.mock("@/lib/mobilenet", () => ({
  loadModel: jest.fn(),
}));

const mockLoadModel = loadModel as jest.Mock;

describe("ModelLoadStatus", () => {
  beforeEach(() => {
    mockLoadModel.mockReset();
  });

  it("shows a loading state while the model is loading", async () => {
    let resolveLoad: () => void = () => {};
    mockLoadModel.mockReturnValue(new Promise((resolve) => (resolveLoad = () => resolve({}))));

    render(<ModelLoadStatus />);
    expect(screen.getByText("Preparing AI model...")).toBeInTheDocument();

    await act(async () => resolveLoad());
    await waitFor(() =>
      expect(screen.getByText("AI model ready for offline classification")).toBeInTheDocument(),
    );
  });

  it("shows a ready state once the model resolves", async () => {
    mockLoadModel.mockResolvedValue({});
    render(<ModelLoadStatus />);
    await waitFor(() =>
      expect(screen.getByText("AI model ready for offline classification")).toBeInTheDocument(),
    );
  });

  it("shows an error state when the model fails to load", async () => {
    mockLoadModel.mockRejectedValue(new Error("offline, no cache"));
    render(<ModelLoadStatus />);
    await waitFor(() =>
      expect(
        screen.getByText("AI model not available offline. Please reconnect to load the model."),
      ).toBeInTheDocument(),
    );
  });

  it("does not update state after unmount", async () => {
    let resolveLoad: () => void = () => {};
    mockLoadModel.mockReturnValue(new Promise((resolve) => (resolveLoad = () => resolve({}))));

    const { unmount } = render(<ModelLoadStatus />);
    unmount();

    // Resolving after unmount must not throw a "state update on unmounted component" warning.
    await act(async () => resolveLoad());
  });

  it("retries loading when the browser comes back online after an error", async () => {
    mockLoadModel.mockRejectedValueOnce(new Error("offline, no cache"));
    render(<ModelLoadStatus />);
    await waitFor(() =>
      expect(
        screen.getByText("AI model not available offline. Please reconnect to load the model."),
      ).toBeInTheDocument(),
    );

    mockLoadModel.mockResolvedValueOnce({});
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(() =>
      expect(screen.getByText("AI model ready for offline classification")).toBeInTheDocument(),
    );
    expect(mockLoadModel).toHaveBeenCalledTimes(2);
  });

  it("does not re-trigger a load on reconnect once the model is already ready", async () => {
    mockLoadModel.mockResolvedValue({});
    render(<ModelLoadStatus />);
    await waitFor(() =>
      expect(screen.getByText("AI model ready for offline classification")).toBeInTheDocument(),
    );

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    expect(mockLoadModel).toHaveBeenCalledTimes(1);
  });
});
