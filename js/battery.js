// The drone's battery settings, as the calculation needs them.

export function readBatteryFields(){
  function num(id){ return parseFloat(document.getElementById(id).value); }
  var picker = document.getElementById('droneModel');
  return { wh: num('batt'), minutes: num('ftime'), massKg: num('mass'), health: num('health'), vmax: num('hor'),
           droneModel: picker ? picker.value : '' };
}
