// Volume of a solid, worked out to a set relative accuracy. replicad's measureVolume uses
// OpenCASCADE's fixed-order integration, which can be off by 0.003% on spline surfaces such as the
// inside of an ellipsoid nose cone; the adaptive Gauss-Kronrod version gets within eps.

import { getOC, type Shape3D } from "replicad";

export function solidVolume(shape: Shape3D, eps = 1e-9): number {
  const oc = getOC();
  const props = new oc.GProp_GProps();
  try {
    oc.BRepGProp.VolumePropertiesGK(shape.wrapped, props, eps, false, true, false, false, false);
    return props.Mass();
  } finally {
    props.delete();
  }
}
