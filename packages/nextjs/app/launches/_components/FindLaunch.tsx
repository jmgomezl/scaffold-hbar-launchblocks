/** Open a launch by its log's topic id. A plain GET form: /launches redirects to /launches/<id>. */
export function FindLaunch() {
  return (
    <form action="/launches" method="get" className="flex flex-wrap items-end gap-2">
      <label className="form-control grow">
        <span className="mb-1 text-sm font-medium">Launch log topic id</span>
        <input
          name="topic"
          required
          pattern="\d+\.\d+\.\d+"
          placeholder="0.0.10716076"
          className="input input-bordered w-full font-mono"
          aria-describedby="find-launch-help"
        />
      </label>
      <button type="submit" className="btn btn-primary">
        Open
      </button>
      <p id="find-launch-help" className="w-full text-xs text-base-content/60">
        The HCS topic the launch opened. After a run, the studio links to it.
      </p>
    </form>
  );
}
