import { describe, expect, it } from "vitest";

const { configurePodDeploymentTargets } = require("./with-ios-pod-deployment-target");

const podfile = `  post_install do |installer|
    react_native_post_install(
      installer,
      config[:reactNativePath],
      :mac_catalyst_enabled => false,
      :ccache_enabled => ccache_enabled?(podfile_properties),
    )
  end
`;

describe("iOS pod deployment targets", () => {
  it("raises every pod target below the app's minimum after React Native's post-install", () => {
    const result = configurePodDeploymentTargets(podfile);
    expect(result).toContain(
      "    )\n    # [paseo] pod deployment targets\n    min_ios = podfile_properties['ios.deploymentTarget'] || '15.1'",
    );
    expect(result).toContain(
      "if config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'].to_f < min_ios.to_f",
    );
    expect(result.indexOf("min_ios")).toBeGreaterThan(result.indexOf("react_native_post_install("));
    expect(result.indexOf("min_ios")).toBeLessThan(result.indexOf("\n  end\n"));
    expect(configurePodDeploymentTargets(result)).toBe(result);
  });

  it("fails prebuild when the template no longer has the post-install hook", () => {
    expect(() => configurePodDeploymentTargets("changed template")).toThrow(
      "Could not raise pod deployment targets after react_native_post_install",
    );
  });
});
